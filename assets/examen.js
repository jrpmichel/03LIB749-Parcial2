/* =====================================================================
   Sinodal — motor genérico del examen en línea (derivado del piloto LEM537)
   Lógica de la aplicación: registro, render de reactivos, autoguardado,
   registro de integridad y disparo de la generación del PDF.
   ===================================================================== */
(function () {
  'use strict';

  var B = window.EXAMEN_BANCO;
  var V = window.EXAMEN_VAR;
  var PREFIJO = B.meta.prefijoArchivo || (B.meta.clave + '_EX');
  var CARGA = Date.now();   // hora de carga: el tiempo en la portada no cuenta como tiempo fuera
  var CC = B.analisis || [];  // Sección C · Análisis (vacía en bancos anteriores a la 0.4)
  var TEORIA = B.meta.estiloA !== 'criterio';

  // ------------------------------------------------------------------ util
  function $(sel, raiz) { return (raiz || document).querySelector(sel); }
  function $$(sel, raiz) { return Array.prototype.slice.call((raiz || document).querySelectorAll(sel)); }

  /* Decodifica base64 con contenido UTF-8. */
  function b64d(s) {
    var bin = atob(s), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  /* Normaliza texto para comparación de canarios: minúsculas, sin acentos ni
     signos, espacios colapsados. */
  function norm(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function dosDig(n) { return (n < 10 ? '0' : '') + n; }

  function hhmmss(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return dosDig(Math.floor(s / 3600)) + ':' + dosDig(Math.floor(s / 60) % 60) + ':' + dosDig(s % 60);
  }

  function fechaLarga(d) {
    var meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
      'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    return d.getDate() + ' de ' + meses[d.getMonth()] + ' de ' + d.getFullYear() +
      ', ' + dosDig(d.getHours()) + ':' + dosDig(d.getMinutes()) + ':' + dosDig(d.getSeconds());
  }

  /* Huella determinista del documento (folio de verificación). */
  function folio(txt) {
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < txt.length; i++) {
      h1 ^= txt.charCodeAt(i); h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 = (Math.imul(h2 ^ txt.charCodeAt(i), 0x85ebca6b)) >>> 0;
    }
    var s = (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
    return (s + '00000000000000').slice(0, 16).toUpperCase().replace(/(.{4})(?=.)/g, '$1-');
  }

  // --------------------------------------------------------------- política
  /* La fija el profesor en Sinodal (paso 1) y se imprime en la portada y en el PDF. Un banco.js
     sin estos campos (construido antes de la 0.3) conserva el comportamiento anterior. */
  function entero(x, omision) {
    var n = parseInt(x, 10);
    return isFinite(n) && n >= 0 ? n : omision;
  }
  var POL = {
    sesion: B.meta.sesionAleatoria === true,
    modo: B.meta.alSalir === 'cerrar' ? 'cerrar' : 'registrar',
    salidas: entero(B.meta.salidasPermitidas, 2),          // salidas toleradas; la siguiente cierra
    segundos: entero(B.meta.segundosFueraPermitidos, 60),  // tiempo fuera tolerado; 0 = sin límite
    pantalla: B.meta.pantallaCompleta === true
  };
  function textoPolitica() {
    if (POL.modo !== 'cerrar') return 'registrar';
    return 'cerrar tras ' + POL.salidas + ' salidas' + (POL.segundos ? ' o ' + POL.segundos + ' s fuera' : '');
  }

  /* Clave de sesión: 6 caracteres en base 32 de Crockford (30 bits) con el generador criptográfico
     del navegador. Entra en la semilla de las variantes junto con la matrícula. */
  var ALFABETO = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  function nuevaSesion() {
    var b = new Uint8Array(6), s = '';
    (window.crypto || window.msCrypto).getRandomValues(b);
    for (var i = 0; i < b.length; i++) s += ALFABETO.charAt(b[i] % 32);
    return s;
  }

  // ---------------------------------------------------------------- estado
  var estado = {
    alumno: { nombre: '', matricula: '', grupo: String(B.meta.grupo || ''), correo: '' },
    sesion: '',        // clave aleatoria de esta sesión ('' si la política no la usa)
    inicio: null,
    fin: null,
    resp: {},          // { A01: 'texto', B01: {T:'', r:'', criterio:''} }
    integridad: {
      copias: 0, caracteresCopiados: 0,
      pegados: 0, caracteresPegados: 0,
      salidas: 0, msFuera: 0, fsSalidas: 0, focosBreves: 0,
      canarios: [],    // canarios detectados en texto pegado
      eventos: []      // bitácora breve [{t, tipo, det}]
    },
    entregado: false,
    cierre: null,      // {motivo: 'salidas'|'tiempo', t} si la política cerró el examen
    reinicios: 0,      // sesiones anteriores de esta matrícula en este navegador
    previas: [],       // resumen de esas sesiones: CLAVE:estado@hh:mm
    folio: '',
    archivo: '',
    ultimo: null,      // última actividad con la ventana al frente
    variantes: {}
  };

  var CANARIOS = [];   // [{id, frase}]
  var claveLS = null;
  var tickReloj = null;
  var pulso = null;
  var salidaDesde = null;
  /* Tipo de la ausencia en curso: 'dialogo' (diálogo propio o cambio de pantalla completa: no cuenta
     si dura poco), 'breve' (perdió el foco sin ocultarse: si vuelve antes de 2 s solo suma el tiempo)
     o 'salida' (cuenta para la política). */
  var tipoSalida = '';
  var timerGracia = null;
  var portadaDesde = null;     // ausencia en curso mientras el alumno está en la portada
  var portadaMs = 0;           // tiempo acumulado fuera de la ventana en la portada
  var timerFuera = null;
  var ignorarFocoHasta = 0;
  var pdfPendiente = false;

  function registraEvento(tipo, det) {
    var e = estado.integridad.eventos;
    if (e.length < 400) {
      e.push({ t: estado.inicio ? Date.now() - estado.inicio : 0, tipo: tipo, det: det || '' });
    }
  }

  /* Con la política «cerrar», entregar o rebasar la tolerancia termina la sesión. */
  function terminado() {
    return POL.modo === 'cerrar' && (estado.entregado || !!estado.cierre);
  }

  /* confirm/alert propios: pueden quitar el foco y sacar de la pantalla completa (Chromium lo hace);
     nada de eso se cuenta. Los eventos llegan con retraso, de ahí el margen después del diálogo. */
  function confirma(msg) {
    ignorarFocoHasta = Infinity;
    try { return window.confirm(msg); } finally { ignorarFocoHasta = Date.now() + 1500; }
  }
  function avisa(msg) {
    ignorarFocoHasta = Infinity;
    try { window.alert(msg); } finally { ignorarFocoHasta = Date.now() + 1500; }
  }

  // ------------------------------------------------------------- persistencia
  function guarda() {
    if (!claveLS) return;
    if (!salidaDesde && !terminado()) estado.ultimo = Date.now();
    try {
      localStorage.setItem(claveLS, JSON.stringify({
        alumno: estado.alumno, sesion: estado.sesion, inicio: estado.inicio, fin: estado.fin,
        resp: estado.resp, integridad: estado.integridad, entregado: estado.entregado,
        cierre: estado.cierre, reinicios: estado.reinicios, previas: estado.previas,
        folio: estado.folio, ultimo: estado.ultimo, fueraDesde: tipoSalida === 'salida' ? salidaDesde : null,
        v: B.meta.version
      }));
    } catch (err) { /* cuota o modo privado: el examen continúa en memoria */ }
  }

  /* La sesión se guarda por la matrícula normalizada sin ceros a la izquierda del número: teclear
     «080844» encuentra la sesión de «80844», y «A00123456» y «B00123456» siguen siendo distintas. */
  function claveDe(matricula) {
    var m = V.normaliza(matricula).replace(/^([A-Z]*)0+(?=\d)/, '$1');
    return PREFIJO + '_' + (m || V.normaliza(matricula));
  }
  function carga(matricula) {
    try {
      var raw = localStorage.getItem(claveDe(matricula)) ||
                localStorage.getItem(PREFIJO + '_' + V.normaliza(matricula));   // sesiones de la 0.2
      return raw ? JSON.parse(raw) : null;
    } catch (err) { return null; }
  }

  function sesionTerminada(prev) {
    return !!prev.cierre || (POL.modo === 'cerrar' && !!prev.entregado);
  }

  /* Datos de la portada, para no recapturarlos tras recargar la página. Solo se ofrecen si esa
     matrícula tiene una sesión sin terminar y reciente: en un equipo compartido, el siguiente
     alumno no debe encontrar los datos del anterior. */
  var RECUERDO = PREFIJO + '_ultimo';
  function recuerdaAlumno() {
    try { localStorage.setItem(RECUERDO, JSON.stringify(estado.alumno)); } catch (err) { }
  }
  function olvidaAlumno() {
    try { localStorage.removeItem(RECUERDO); } catch (err) { }
  }
  function alumnoRecordado() {
    var a = null;
    try { a = JSON.parse(localStorage.getItem(RECUERDO) || 'null'); } catch (err) { }
    if (!a || !a.matricula) return null;
    var prev = carga(a.matricula);
    var reciente = prev && prev.inicio && CARGA - (prev.ultimo || prev.inicio) < 4 * 3600000;
    if (!reciente || sesionTerminada(prev) || prev.entregado) { olvidaAlumno(); return null; }
    return a;
  }

  // ------------------------------------------------------------------ render
  function parrafos(lineas, vars) {
    return lineas.map(function (l) {
      var t = vars ? V.texto(l, vars) : l;
      var esInciso = /^\((i|ii|iii|iv|v)\)/.test(t.trim());
      return '<p class="' + (esInciso ? 'inciso' : '') + '">' + escapa(t) + '</p>';
    }).join('');
  }

  function escapa(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function trampaHTML(r) {
    if (!r.t) return '';
    // Respaldo pasivo: el mismo bloque queda en el DOM, invisible y fuera del
    // árbol de accesibilidad, de modo que una selección amplia lo arrastre.
    return '<span class="oculto" aria-hidden="true">' + escapa(b64d(r.t)) + '</span>';
  }

  function tarjetaTeorico(r, idx) {
    var art = document.createElement('article');
    art.className = 'reactivo';
    art.id = 'r-' + r.id;
    if (r.t) art.setAttribute('data-trampa', r.t);
    art.innerHTML =
      '<div class="reactivo-cab">' +
        '<span class="reactivo-num">A' + dosDig(idx + 1) + '</span>' +
        '<span class="reactivo-tit">' + escapa(r.titulo) + '</span>' +
        '<span class="reactivo-meta">' + r.puntos + ' pts · ' + escapa(r.tema) + '</span>' +
      '</div>' +
      '<div class="enunciado">' + parrafos(r.texto) + trampaHTML(r) + '</div>' +
      '<div class="campo" style="margin-top:12px">' +
        '<label for="ta-' + r.id + '">Respuesta</label>' +
        '<textarea id="ta-' + r.id + '" data-rid="' + r.id + '" maxlength="3000" ' +
        'placeholder="' + (TEORIA ? 'Responda los tres incisos: idea central, explicación y aplicación o condición de validez.'
                                  : 'Redacte su dictamen. Declare hipótesis, criterio y consecuencia; responda los tres incisos.') +
        '"></textarea>' +
        '<div class="contador" id="c-' + r.id + '">0 caracteres</div>' +
      '</div>';
    return art;
  }

  function tarjetaNumerico(r, idx, vars, letra) {
    letra = letra || 'B';
    var art = document.createElement('article');
    art.className = 'reactivo';
    art.id = 'r-' + r.id;
    if (r.t) art.setAttribute('data-trampa', r.t);

    var campos = r.campos.map(function (c) {
      return '<div class="campo-num">' +
        '<label for="n-' + r.id + '-' + c.k + '">' + escapa(c.et) +
        (c.u ? ' <span class="u">[' + escapa(c.u) + ']</span>' : '') + '</label>' +
        '<input type="text" inputmode="decimal" autocomplete="off" spellcheck="false" ' +
        'id="n-' + r.id + '-' + c.k + '" data-rid="' + r.id + '" data-campo="' + c.k + '" ' +
        'placeholder="valor numérico (coma o punto decimal)">' +
      '</div>';
    }).join('');

    art.innerHTML =
      '<div class="reactivo-cab">' +
        '<span class="reactivo-num">' + letra + dosDig(idx + 1) + '</span>' +
        '<span class="reactivo-tit">' + escapa(r.titulo) + '</span>' +
        '<span class="reactivo-meta">' + r.puntos + ' pts · ' + escapa(r.tema) + '</span>' +
      '</div>' +
      '<div class="enunciado">' + parrafos(r.texto, vars) + trampaHTML(r) + '</div>' +
      '<div class="campos-num">' + campos + '</div>' +
      (letra === 'C'
        ? '<div class="campo">' +
            '<label for="an-' + r.id + '">Análisis: responda los incisos (i), (ii) y (iii) con base en sus resultados</label>' +
            '<textarea id="an-' + r.id + '" data-rid="' + r.id + '" data-campo="analisis" ' +
            'maxlength="4000" style="min-height:150px" ' +
            'placeholder="(i) Dictamen con sus números · (ii) mecanismo que gobierna el resultado · (iii) medida concreta con su magnitud."></textarea>' +
            '<div class="contador" id="c-' + r.id + '">0 caracteres</div>' +
          '</div>'
        : '<div class="campo">' +
            '<label for="cr-' + r.id + '">Criterio empleado (obligatorio)</label>' +
            '<textarea id="cr-' + r.id + '" data-rid="' + r.id + '" data-campo="criterio" ' +
            'maxlength="700" style="min-height:70px" ' +
            'placeholder="Modelo y ecuación usados, base del esfuerzo nominal o del área, hipótesis, y qué gobierna el resultado."></textarea>' +
          '</div>');
    return art;
  }

  function pintaExamen() {
    var lt = $('#listaTeoricos'), ln = $('#listaNumericos'), la = $('#listaAnalisis');
    lt.innerHTML = ''; ln.innerHTML = '';
    if (la) la.innerHTML = '';

    // Canarios genéricos: presentes en todos los payloads. Delatan el uso de un
    // asistente externo pero no atribuyen el copiado a un reactivo concreto.
    (B.meta.canariosGenericos || []).forEach(function (c) {
      CANARIOS.push({ id: 'GEN', frase: norm(b64d(c)) });
    });

    B.teoricos.forEach(function (r, i) {
      lt.appendChild(tarjetaTeorico(r, i));
      if (r.c) r.c.forEach(function (c) { CANARIOS.push({ id: r.id, frase: norm(b64d(c)) }); });
    });

    B.numericos.forEach(function (r, i) {
      var vars = V.resolver(r, estado.alumno.matricula, estado.sesion);
      estado.variantes[r.id] = vars;
      ln.appendChild(tarjetaNumerico(r, i, vars));
      if (r.c) r.c.forEach(function (c) { CANARIOS.push({ id: r.id, frase: norm(b64d(c)) }); });
    });

    CC.forEach(function (r, i) {
      var vars = V.resolver(r, estado.alumno.matricula, estado.sesion);
      estado.variantes[r.id] = vars;
      if (la) la.appendChild(tarjetaNumerico(r, i, vars, 'C'));
      if (r.c) r.c.forEach(function (c) { CANARIOS.push({ id: r.id, frase: norm(b64d(c)) }); });
    });

    // Restaura respuestas guardadas
    B.teoricos.forEach(function (r) {
      var v = estado.resp[r.id];
      if (typeof v === 'string' && v) { $('#ta-' + r.id).value = v; }
    });
    B.numericos.concat(CC).forEach(function (r) {
      var v = estado.resp[r.id] || {};
      r.campos.forEach(function (c) {
        if (v[c.k]) $('#n-' + r.id + '-' + c.k).value = v[c.k];
      });
      if (v.criterio && $('#cr-' + r.id)) $('#cr-' + r.id).value = v.criterio;
      if (v.analisis && $('#an-' + r.id)) $('#an-' + r.id).value = v.analisis;
    });


    $('#cabeceraExamen').innerHTML =
      '<b>' + escapa(estado.alumno.nombre) + '</b> · Matrícula ' + escapa(estado.alumno.matricula) +
      ' · Grupo ' + escapa(estado.alumno.grupo) +
      (estado.sesion ? ' · Clave de sesión <b>' + escapa(estado.sesion) + '</b>' : '') + '<br>' +
      'Inicio de la sesión: ' + fechaLarga(new Date(estado.inicio)) +
      ' · Duración de referencia: ' + B.meta.duracionMin + ' minutos.';

    engancharEntradas();
    $$('#listaAnalisis textarea').forEach(function (ta) { ta.dispatchEvent(new Event('input')); });   // contadores
    actualizaProgreso();
  }

  // --------------------------------------------------------------- entradas
  function engancharEntradas() {
    $$('#listaTeoricos textarea').forEach(function (ta) {
      ta.addEventListener('input', function () {
        estado.resp[ta.dataset.rid] = ta.value;
        var c = $('#c-' + ta.dataset.rid);
        var n = ta.value.trim().length;
        c.textContent = n + ' caracteres';
        c.className = 'contador' + (n > 0 && n < 220 ? ' corto' : '');
        marcaContestado(ta.dataset.rid);
        actualizaProgreso();
        guarda();
      });
      ta.dispatchEvent(new Event('input'));
    });

    $$('#listaNumericos input, #listaNumericos textarea, #listaAnalisis input, #listaAnalisis textarea').forEach(function (el) {
      el.addEventListener('input', function () {
        var rid = el.dataset.rid;
        estado.resp[rid] = estado.resp[rid] || {};
        estado.resp[rid][el.dataset.campo] = el.value;
        if (el.dataset.campo === 'analisis') {
          var c = $('#c-' + rid), n = el.value.trim().length;
          if (c) { c.textContent = n + ' caracteres'; c.className = 'contador' + (n > 0 && n < 220 ? ' corto' : ''); }
        }
        marcaContestado(rid);
        actualizaProgreso();
        guarda();
      });
    });
  }

  /* letra: 'A' (texto), 'B' (campos + criterio) o 'C' (campos + análisis). */
  function completo(r, letra) {
    if (letra === 'A') return (estado.resp[r.id] || '').trim().length >= 40;
    var v = estado.resp[r.id] || {};
    var todos = r.campos.every(function (c) { return String(v[c.k] || '').trim() !== ''; });
    if (letra === 'C') return todos && String(v.analisis || '').trim().length >= 60;
    return todos && String(v.criterio || '').trim().length >= 15;
  }

  function buscaReactivo(rid) {
    var listas = { A: B.teoricos, B: B.numericos, C: CC }, letra = rid.charAt(0);
    var r = (listas[letra] || []).filter(function (x) { return x.id === rid; })[0];
    return r ? { r: r, letra: letra } : null;
  }

  function marcaContestado(rid) {
    var art = $('#r-' + rid), h = buscaReactivo(rid);
    if (!art || !h) return;
    art.classList.toggle('contestado', completo(h.r, h.letra));
  }

  function pendientes() {
    var p = [];
    B.teoricos.forEach(function (r, i) { if (!completo(r, 'A')) p.push('A' + dosDig(i + 1)); });
    B.numericos.forEach(function (r, i) { if (!completo(r, 'B')) p.push('B' + dosDig(i + 1)); });
    CC.forEach(function (r, i) { if (!completo(r, 'C')) p.push('C' + dosDig(i + 1)); });
    return p;
  }

  function actualizaProgreso() {
    var p = pendientes();
    var total = B.teoricos.length + B.numericos.length + CC.length;
    $('#chipProgreso').textContent = (total - p.length) + ' / ' + total + ' contestados';
    var av = $('#avisoPendientes');
    av.textContent = p.length
      ? 'Reactivos incompletos: ' + p.join(', ') + '. Puede entregar de todos modos, pero se registrarán como no contestados.'
      : '';
  }

  // ------------------------------------------------------------- integridad
  function instalaIntegridad() {
    // 1) Copiado: se antepone el texto seleccionado y se anexan las marcas de
    //    trazabilidad de los reactivos que la selección toca.
    document.addEventListener('copy', function (e) {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;                   // copia dentro de un campo
      var texto = sel.toString();
      if (!texto || texto.length < 3) return;

      estado.integridad.copias++;
      estado.integridad.caracteresCopiados += texto.length;

      var cargas = [], tocados = [];
      try {
        var rango = sel.getRangeAt(0);
        $$('[data-trampa]').forEach(function (el) {
          if (rango.intersectsNode(el)) {
            cargas.push(b64d(el.dataset.trampa));
            tocados.push(el.id.replace('r-', ''));
          }
        });
      } catch (err) { /* selecciones exóticas */ }

      registraEvento('copia', tocados.join(',') + ' (' + texto.length + ' car.)');
      guarda();

      if (!cargas.length || !e.clipboardData) return;
      var salida = texto + '\n\n' + cargas.join('\n\n');
      e.clipboardData.setData('text/plain', salida);
      e.clipboardData.setData('text/html',
        '<div>' + escapa(texto).replace(/\n/g, '<br>') + '</div><div>' +
        escapa(cargas.join('\n\n')).replace(/\n/g, '<br>') + '</div>');
      e.preventDefault();
    }, true);

    // 2) Pegado: se cuenta y se inspecciona en busca de frases canario.
    document.addEventListener('paste', function (e) {
      var txt = '';
      try { txt = (e.clipboardData || window.clipboardData).getData('text') || ''; } catch (err) { }
      estado.integridad.pegados++;
      estado.integridad.caracteresPegados += txt.length;
      var n = norm(txt), hallados = [];
      CANARIOS.forEach(function (c) {
        if (c.frase && n.indexOf(c.frase) >= 0 && hallados.indexOf(c.id) < 0) hallados.push(c.id);
      });
      if (hallados.length) {
        hallados.forEach(function (h) {
          if (estado.integridad.canarios.indexOf(h) < 0) estado.integridad.canarios.push(h);
        });
      }
      registraEvento('pegado', txt.length + ' car.' + (hallados.length ? ' · CANARIO ' + hallados.join(',') : ''));
      guarda();
    }, true);

    // 3) Foco de la ventana: número de salidas y tiempo acumulado fuera. Con la política
    //    «cerrar», rebasar la tolerancia termina el examen aunque el alumno siga fuera.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (salidaDesde && tipoSalida === 'breve') promover(); else fuera();
      } else { dentro(); mantenerPantalla(); }
    });
    window.addEventListener('blur', fuera);
    window.addEventListener('focus', dentro);
    // Teclear o pulsar dentro del examen prueba que el alumno está en él aunque no llegara el evento focus.
    ['keydown', 'pointerdown', 'input'].forEach(function (ev) {
      document.addEventListener(ev, function () { if (salidaDesde || portadaDesde) dentro(); }, true);
    });

    // 4) Pantalla completa: salir de ella se registra; con «cerrar» se bloquea hasta volver.
    ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (ev) {
      document.addEventListener(ev, function () {
        if (enPantallaCompleta() || !estado.inicio || terminado() || !POL.pantalla) return;
        if (Date.now() >= ignorarFocoHasta) {     // no la provocó un diálogo propio
          estado.integridad.fsSalidas++;
          registraEvento('pantalla', 'salió de la pantalla completa');
          guarda();
        }
        if (POL.modo === 'cerrar' && !veloVisible()) velo('pantalla');
      });
    });

    // El PDF de un cierre ocurrido con la ventana en segundo plano se descarga al volver.
    function alVolver() {
      if (pdfPendiente && !document.hidden) { try { descargarPDF(); } catch (err) { } }
    }
    document.addEventListener('visibilitychange', alVolver);
    window.addEventListener('focus', alVolver);

    window.addEventListener('pagehide', guarda);
    window.addEventListener('beforeunload', function (ev) {
      if (estado.inicio && !estado.entregado) {
        guarda();
        ev.preventDefault();
        ev.returnValue = '';
        return '';
      }
    });
  }

  function fuera() {
    if (!estado.inicio) {                                 // en la portada: solo se mide
      if (!portadaDesde && Date.now() >= ignorarFocoHasta) portadaDesde = Date.now();
      return;
    }
    if (salidaDesde || terminado()) return;
    salidaDesde = Date.now();
    clearTimeout(timerGracia);
    if (document.hidden) {                                // un diálogo propio no oculta la página
      tipoSalida = 'salida';
      contarSalida();
    } else if (Date.now() < ignorarFocoHasta) {
      tipoSalida = 'dialogo';
      timerGracia = setTimeout(revisaGracia, 3000);
    } else {
      tipoSalida = 'breve';
      timerGracia = setTimeout(revisaGracia, 2000);
    }
  }

  /* Vence la gracia: si la página tiene el foco (se perdió el evento focus), es un regreso. */
  function revisaGracia() {
    if (!salidaDesde || tipoSalida === 'salida') return;
    if (presente()) { dentro(); return; }
    promover();
  }

  function promover() {
    clearTimeout(timerGracia);
    tipoSalida = 'salida';
    contarSalida();
  }

  function presente() {
    return !document.hidden && document.hasFocus();
  }

  function contarSalida() {
    estado.integridad.salidas++;
    registraEvento('salida', '');
    guarda();
    if (POL.modo !== 'cerrar') return;
    var m = excedido();
    if (m) cerrarPorPolitica(m); else programaLimite();
  }

  function dentro() {
    if (portadaDesde) { portadaMs += Date.now() - portadaDesde; portadaDesde = null; }
    if (!salidaDesde) return;
    var d = Date.now() - salidaDesde, tipo = tipoSalida;
    salidaDesde = null;
    tipoSalida = '';
    clearTimeout(timerGracia);
    clearTimeout(timerFuera);
    // Diálogo propio o cambio de pantalla completa: sus eventos llegan juntos al cerrarse; si la
    // ausencia dura un segundo o más, el alumno sí dejó la ventana y se registra como pérdida breve.
    if (tipo === 'dialogo' && d < 1000) return;
    estado.integridad.msFuera += d;
    if (tipo !== 'salida') {
      estado.integridad.focosBreves = (estado.integridad.focosBreves || 0) + 1;
      registraEvento('foco', (d / 1000).toFixed(1) + ' s');
    } else {
      registraEvento('regreso', Math.round(d / 1000) + ' s');
    }
    guarda();
    if (POL.modo !== 'cerrar' || terminado()) return;
    var m = excedido();
    if (m) cerrarPorPolitica(m); else if (tipo === 'salida') velo('aviso');
  }

  function msFueraAhora() {
    return estado.integridad.msFuera + (salidaDesde && tipoSalida !== 'dialogo' ? Date.now() - salidaDesde : 0);
  }

  function excedido() {
    if (POL.modo !== 'cerrar' || terminado() || !estado.inicio) return null;
    if (estado.integridad.salidas > POL.salidas) return 'salidas';
    if (POL.segundos && msFueraAhora() > POL.segundos * 1000) return 'tiempo';
    return null;
  }

  /* Mientras el alumno está fuera, el cierre por tiempo ocurre a la hora exacta. */
  function programaLimite() {
    clearTimeout(timerFuera);
    if (POL.modo !== 'cerrar' || !POL.segundos || !salidaDesde) return;
    var resta = POL.segundos * 1000 - msFueraAhora();
    timerFuera = setTimeout(function () {
      if (salidaDesde && presente()) { dentro(); return; }   // volvió sin que llegara el evento focus
      var m = excedido();
      if (m) cerrarPorPolitica(m); else programaLimite();
    }, Math.max(50, resta + 50));
  }

  function cerrarPorPolitica(motivo) {
    if (terminado()) return;
    estado.cierre = { motivo: motivo, t: Date.now() };
    registraEvento('cierre', motivo === 'tiempo' ? 'tiempo fuera de la ventana' : 'número de salidas');
    sellar();
    estado.entregado = true;
    guarda();
    bloquear();
    velo('fin');
    if (!presente()) { pdfPendiente = true; return; }
    try { descargarPDF(); } catch (err) { /* el velo ya muestra el error y el botón para reintentar */ }
  }

  // ----------------------------------------------------------- pantalla completa
  function enPantallaCompleta() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }
  function puedePantallaCompleta() {
    var el = document.documentElement;
    return !!(el.requestFullscreen || el.webkitRequestFullscreen);
  }
  function entrarPantallaCompleta() {
    if (!POL.pantalla || enPantallaCompleta() || !puedePantallaCompleta()) return;
    var el = document.documentElement;
    ignorarFocoHasta = Math.max(ignorarFocoHasta, Date.now() + 1500);
    try {
      var pr = (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
      if (pr && pr.catch) pr.catch(function () { });
    } catch (err) { /* sin gesto del usuario o sin permiso */ }
  }
  function salirPantallaCompleta() {
    if (!enPantallaCompleta()) return;
    ignorarFocoHasta = Math.max(ignorarFocoHasta, Date.now() + 1500);
    try {
      var pr = (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      if (pr && pr.catch) pr.catch(function () { });
    } catch (err) { }
  }

  /* Pantalla siempre encendida mientras dura el examen: en celulares, el bloqueo automático por
     inactividad dispararía una salida (y, con «cerrar», el cierre) mientras el alumno piensa. */
  var wakeLock = null;
  function mantenerPantalla() {
    if (!('wakeLock' in navigator) || !estado.inicio || terminado() || document.hidden) return;
    try {
      navigator.wakeLock.request('screen').then(function (w) { wakeLock = w; }).catch(function () { });
    } catch (err) { }
  }
  function soltarPantalla() {
    if (wakeLock) { try { wakeLock.release(); } catch (err) { } wakeLock = null; }
  }

  // --------------------------------------------------------------------- velo
  /* Capa que cubre el examen: aviso tras una salida tolerada, regreso a pantalla completa
     y pantalla final (entregado o cerrado por la política). */
  function velo(tipo) {
    var v = $('#velo'), t = $('#veloTitulo'), x = $('#veloTexto'), b = $('#veloBoton');
    if (!v || !t || !x || !b) return;          // index.html de una versión anterior (caché)
    var ig = estado.integridad;
    v.className = 'velo ' + tipo;
    if (tipo === 'aviso') {
      var quedan = POL.salidas - ig.salidas;
      t.textContent = 'Salió de la ventana del examen';
      x.innerHTML = '<p>Salida <b>' + ig.salidas + '</b> de ' + POL.salidas + ' permitidas' +
        (POL.segundos ? ' · tiempo fuera acumulado <b>' + Math.round(ig.msFuera / 1000) + ' s</b> de ' +
          POL.segundos + ' s' : '') + '.</p><p>' +
        (quedan <= 0 ? '<b>La próxima salida cierra el examen.</b>'
          : 'Le ' + (quedan === 1 ? 'queda 1 salida' : 'quedan ' + quedan + ' salidas') + ' antes del cierre.') +
        ' Al cerrarse, el PDF se genera con lo que haya contestado hasta ese momento.</p>' +
        '<p class="tenue">Cambiar a otra ventana, pestaña o aplicación, o recargar la página, cuenta como salida.</p>';
      b.textContent = 'Volver al examen';
    } else if (tipo === 'pantalla') {
      t.textContent = 'El examen se resuelve en pantalla completa';
      x.innerHTML = '<p>Salir de la pantalla completa queda registrado en el PDF. Para continuar, vuelva a ella.</p>';
      b.textContent = 'Volver a pantalla completa';
    } else {
      var c = estado.cierre;
      t.textContent = c ? 'Examen cerrado por la política de salidas' : 'Examen terminado';
      x.innerHTML = (c ? '<p>' + (c.motivo === 'tiempo'
          ? 'Acumuló ' + Math.round(ig.msFuera / 1000) + ' s fuera de la ventana; se permitían ' + POL.segundos + ' s.'
          : 'Salió de la ventana ' + ig.salidas + ' veces; se permitían ' + POL.salidas + '.') +
          ' El PDF contiene lo que había contestado hasta ese momento.</p>' : '') +
        '<p>Archivo: <b>' + escapa(estado.archivo) + '</b><br>Folio: <code>' + estado.folio + '</code>' +
        (estado.sesion ? ' · Clave de sesión: <code>' + estado.sesion + '</code>' : '') +
        ' · Duración: ' + hhmmss(estado.fin - estado.inicio) + '</p>' +
        '<p>Suba este archivo, sin modificarlo ni renombrarlo, a la tarea de ' +
        escapa(B.meta.plataforma || 'la plataforma del curso') + ' «' + escapa(B.meta.evaluacion) + ' — ' +
        escapa(B.meta.clave) + '». Si la descarga no comenzó, use el botón.</p>';
      b.textContent = 'Descargar el PDF';
      salirPantallaCompleta();
    }
    v.hidden = false;
    b.focus();
  }

  function veloVisible() {
    var v = $('#velo');
    return !!(v && !v.hidden);
  }

  function botonVelo() {
    var v = $('#velo');
    if (v.classList.contains('fin')) { try { descargarPDF(); } catch (err) { } return; }
    v.hidden = true;
    entrarPantallaCompleta();
  }

  /* Rastro de canarios en el texto final de las respuestas: si el alumno pegó
     la respuesta de un asistente, es probable que arrastre la frase exigida. */
  function canariosEnRespuestas() {
    var out = [];
    Object.keys(estado.resp).forEach(function (rid) {
      var v = estado.resp[rid];
      var txt = (typeof v === 'string') ? v : Object.keys(v).map(function (k) { return v[k]; }).join(' ');
      var n = norm(txt);
      CANARIOS.forEach(function (c) {
        if (c.frase && n.indexOf(c.frase) >= 0 && out.indexOf(rid) < 0) out.push(rid);
      });
      if (n.indexOf('fe de erratas') >= 0 && out.indexOf(rid) < 0) out.push(rid);
    });
    return out;
  }

  // ------------------------------------------------------------------ reloj
  function arrancaReloj() {
    function pinta() {
      var fin = estado.fin && terminado() ? estado.fin : Date.now();
      var ms = fin - estado.inicio;
      var chip = $('#chipReloj');
      chip.textContent = hhmmss(ms);
      chip.classList.toggle('alerta', ms > B.meta.duracionMin * 60000);
      if (salidaDesde && presente()) dentro();                        // se perdió el evento focus
      else if (salidaDesde && excedido()) cerrarPorPolitica(excedido());   // respaldo del temporizador
    }
    pinta();
    clearInterval(tickReloj);
    tickReloj = setInterval(pinta, 1000);
    clearInterval(pulso);
    pulso = setInterval(function () { if (!salidaDesde && !terminado()) guarda(); }, 5000);
  }

  // ------------------------------------------------------------------ flujo
  function validaPortada() {
    var nombre = $('#fNombre').value.trim();
    var mat = $('#fMatricula').value.trim();
    var ok = nombre.length >= 6 && V.normaliza(mat).length >= 4 && $('#fDeclaro').checked;
    $('#btnIniciar').disabled = !ok;
    return ok;
  }

  function horaCorta(t) {
    var d = new Date(t);
    return dosDig(d.getHours()) + ':' + dosDig(d.getMinutes());
  }
  function describeSesion(prev) {
    return ' (clave de sesión ' + (prev.sesion || '—') + ', iniciada el ' + fechaLarga(new Date(prev.inicio)) + ')';
  }
  function resumenSesion(prev) {
    return (prev.sesion || 'SINCLAVE') + ':' +
      (prev.cierre ? 'cerrada' : prev.entregado ? 'entregada' : 'abandonada') + '@' + horaCorta(prev.inicio);
  }

  function restaura(prev) {
    if (prev.alumno && prev.alumno.matricula) estado.alumno = prev.alumno;   // la semilla es la de esa sesión
    claveLS = claveDe(estado.alumno.matricula);
    estado.sesion = prev.sesion || '';
    estado.inicio = prev.inicio;
    estado.fin = prev.fin || null;
    estado.resp = prev.resp || {};
    if (prev.integridad) estado.integridad = prev.integridad;
    var ig = estado.integridad;
    if (!ig.eventos) ig.eventos = [];
    if (!ig.fsSalidas) ig.fsSalidas = 0;
    if (!ig.focosBreves) ig.focosBreves = 0;
    estado.entregado = POL.modo === 'cerrar' && !!prev.entregado;   // en «registrar» se sigue editando
    if (!estado.entregado && !prev.cierre) estado.fin = null;
    estado.cierre = prev.cierre || null;
    estado.reinicios = prev.reinicios || 0;
    estado.previas = prev.previas || [];
    estado.folio = prev.folio || '';
    estado.archivo = nombreArchivo();
  }

  /* Tiempo entre la última actividad de la sesión guardada y su reanudación: cuenta como salida. */
  function cuentaRecarga(prev) {
    var ig = estado.integridad;
    // Tiempo fuera de la ventana con la portada abierta: el alumno ya había visto el examen.
    var enPortada = portadaMs + (portadaDesde ? Date.now() - portadaDesde : 0);
    portadaMs = 0;
    portadaDesde = null;
    if (prev.fueraDesde) {                       // la página se cerró estando fuera: la salida ya contaba
      var d = Math.max(0, CARGA - prev.fueraDesde) + enPortada;
      ig.msFuera += d;
      registraEvento('regreso', 'recarga de la página, ' + Math.round(d / 1000) + ' s');
      return true;
    }
    if (!prev.ultimo) return false;              // sesión guardada por la 0.2: no hay con qué medir
    var hueco = CARGA - prev.ultimo + enPortada;
    if (hueco < 4000) return false;
    ig.salidas++;
    ig.msFuera += hueco;
    registraEvento('salida', 'recarga de la página, ' + Math.round(hueco / 1000) + ' s');
    return true;
  }

  function iniciar() {
    if (!validaPortada()) return;
    entrarPantallaCompleta();                   // dentro del clic: el navegador exige un gesto del usuario
    estado.alumno = {
      nombre: $('#fNombre').value.trim(),
      matricula: $('#fMatricula').value.trim().toUpperCase(),
      grupo: $('#fGrupo').value.trim() || String(B.meta.grupo || ''),
      correo: $('#fCorreo').value.trim()
    };
    claveLS = claveDe(estado.alumno.matricula);

    var prev = carga(estado.alumno.matricula), reanuda = false, previas = [];
    if (prev && prev.inicio) {
      if (sesionTerminada(prev)) {
        if (confirma('Esta matrícula ya terminó un examen en este navegador' + describeSesion(prev) + '.\n\n' +
                     'Aceptar: ver esa sesión y volver a descargar su PDF.\n' +
                     'Cancelar: iniciar una sesión nueva. ' + (POL.sesion ? 'Los datos numéricos cambian y el ' : 'El ') +
                     'reinicio queda registrado en el PDF.')) {
          restaura(prev);
          mostrarExamen();
          velo('fin');
          return;
        }
        previas = (prev.previas || []).concat([resumenSesion(prev)]);
      } else if (confirma('Se encontró una sesión sin terminar de esta matrícula en este navegador' +
                          describeSesion(prev) + '.\n\n' +
                          'Aceptar: continuar esa sesión, con sus datos y respuestas. El tiempo transcurrido ' +
                          'desde que dejó la página queda registrado como salida de la ventana.\n' +
                          'Cancelar: iniciar una sesión nueva' + (POL.sesion ? ' con datos distintos' : '') +
                          '; se pierden las respuestas guardadas y el reinicio queda registrado.')) {
        restaura(prev);
        reanuda = cuentaRecarga(prev);
      } else {
        previas = (prev.previas || []).concat([resumenSesion(prev)]);
      }
    }
    recuerdaAlumno();
    if (!estado.inicio) {
      estado.inicio = Date.now();
      estado.sesion = POL.sesion ? nuevaSesion() : '';
      estado.previas = previas;
      estado.reinicios = previas.length;
      if (previas.length) registraEvento('sesión nueva', 'sesiones anteriores: ' + previas.join(', '));
    }
    estado.archivo = nombreArchivo();

    mostrarExamen();
    if (terminado()) { velo('fin'); return; }
    if (POL.modo === 'cerrar') {
      var m = excedido();
      if (m) { cerrarPorPolitica(m); return; }
      if (reanuda) { velo('aviso'); return; }
      // Si el navegador no concedió la pantalla completa (o la soltó al mostrar un diálogo), se pide con un botón.
      if (POL.pantalla && puedePantallaCompleta()) {
        setTimeout(function () {
          if (!enPantallaCompleta() && !veloVisible() && !terminado()) velo('pantalla');
        }, 700);
      }
    }
  }

  function mostrarExamen() {
    $('#pantallaPortada').hidden = true;
    $('#pantallaExamen').hidden = false;
    $('#barra').hidden = false;
    $('#barraQuien').textContent = estado.alumno.matricula + (estado.sesion ? ' · sesión ' + estado.sesion : '');
    pintaExamen();
    arrancaReloj();
    if (terminado()) bloquear(); else mantenerPantalla();
    guarda();
    window.scrollTo(0, 0);
  }

  function nombreArchivo() {
    var apellido = estado.alumno.nombre.split(/[ ,]+/)[0] || 'ALUMNO';
    apellido = apellido.normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    return PREFIJO + '_' + V.normaliza(estado.alumno.matricula) + '_' + (apellido || 'ALUMNO') + '.pdf';
  }

  /* Fija la hora de término, el folio y el nombre del archivo. No bloquea: quien llama decide. */
  function sellar() {
    estado.fin = Date.now();
    if (salidaDesde) {
      if (tipoSalida !== 'dialogo') estado.integridad.msFuera += Date.now() - salidaDesde;
      salidaDesde = null;
      tipoSalida = '';
    }
    clearTimeout(timerFuera);
    clearTimeout(timerGracia);
    canariosEnRespuestas().forEach(function (a) {
      if (estado.integridad.canarios.indexOf(a) < 0) estado.integridad.canarios.push(a);
    });
    // Sin clave de sesión, el folio se calcula exactamente como en la versión anterior.
    var base = estado.alumno.matricula + '|' + (estado.sesion ? estado.sesion + '|' : '') +
      estado.inicio + '|' + estado.fin + '|' + JSON.stringify(estado.resp);
    estado.folio = folio(base);
    estado.archivo = nombreArchivo();
  }

  function bloquear() {
    $$('#pantallaExamen textarea, #pantallaExamen input').forEach(function (el) { el.readOnly = true; });
    $('#btnGenerar').textContent = 'Descargar de nuevo el PDF';
    clearInterval(pulso);
    clearInterval(tickReloj);
    soltarPantalla();
    olvidaAlumno();
    var ms = (estado.fin || Date.now()) - estado.inicio;
    $('#chipReloj').textContent = hhmmss(ms);
  }

  function descargarPDF() {
    pdfPendiente = false;
    try {
      window.EXAMEN_PDF.generar({
        meta: B.meta, banco: B, estado: estado, folio: estado.folio,
        archivo: estado.archivo,
        util: { hhmmss: hhmmss, fechaLarga: fechaLarga, politica: textoPolitica }
      });
    } catch (err) {
      pdfPendiente = false;
      if (veloVisible()) {
        var previo = $('#veloTexto .error-pdf');
        if (previo) previo.parentNode.removeChild(previo);
        $('#veloTexto').innerHTML += '<p class="error-pdf" style="color:#b42318"><b>No se pudo generar el PDF:</b> ' +
          escapa(err.message) + '. Avise al profesor de inmediato; sus respuestas están guardadas en este ' +
          'navegador. Puede reintentar con el botón.</p>';
      } else {
        avisa('Ocurrió un error al generar el PDF:\n\n' + err.message +
              '\n\nAvise al profesor de inmediato. Sus respuestas siguen guardadas en este navegador.');
      }
      throw err;
    }
    var av = $('#avisoDescarga');
    av.hidden = false;
    av.innerHTML = '<b>PDF generado: ' + escapa(estado.archivo) + '</b><br>' +
      'Folio de verificación: <code>' + estado.folio + '</code>' +
      (estado.sesion ? ' · Clave de sesión: <code>' + estado.sesion + '</code>' : '') +
      ' · Duración de la sesión: ' + hhmmss(estado.fin - estado.inicio) + '<br>' +
      'Suba este archivo, sin modificarlo ni renombrarlo, a la tarea de ' + escapa(B.meta.plataforma || 'la plataforma del curso') + ' ' +
      '«' + escapa(B.meta.evaluacion) + ' — ' + escapa(B.meta.clave) + '». ' +
      (POL.modo === 'cerrar' ? 'El examen quedó cerrado: ya no se pueden modificar las respuestas.'
        : 'Si necesita corregir una respuesta puede hacerlo y volver a generar el PDF: entregue únicamente la última versión.');
    if (!veloVisible()) av.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function generarPDF() {
    if (terminado()) { descargarPDF(); return; }
    var p = pendientes();
    var aviso = p.length ? 'Quedan ' + p.length + ' reactivo(s) incompleto(s): ' + p.join(', ') + '.\n\n' : '';
    if (POL.modo === 'cerrar') {
      if (!confirma(aviso + 'Al generar el PDF el examen termina: se registra la hora de término y ya no podrá ' +
                    'modificar las respuestas.\n\n¿Terminar el examen y generar el PDF?')) return;
      if (terminado()) return;                  // la política lo cerró mientras el diálogo estaba abierto
    } else if (p.length && !confirma(aviso + '¿Generar el PDF de todos modos?')) {
      return;
    }
    var antes = { fin: estado.fin, folio: estado.folio };
    sellar();
    try {
      descargarPDF();                           // primero el PDF: si falla, el examen sigue abierto
    } catch (err) {
      estado.fin = antes.fin;
      estado.folio = antes.folio;
      guarda();
      return;
    }
    estado.entregado = true;
    guarda();
    olvidaAlumno();                             // equipo compartido: el siguiente alumno no ve estos datos
    if (POL.modo === 'cerrar') { bloquear(); velo('fin'); }
  }

  // -------------------------------------------------------------- arranque
  document.addEventListener('DOMContentLoaded', function () {
    $('#logo').src = window.EXAMEN_LOGO;
    $('#verInstrumento').textContent = B.meta.version + ' · ' + B.meta.periodo;

    var a = alumnoRecordado();                 // solo si esa matrícula tiene una sesión sin terminar
    if (a) {
      if (a.nombre) $('#fNombre').value = a.nombre;
      if (a.matricula) $('#fMatricula').value = a.matricula;
      if (a.grupo) $('#fGrupo').value = a.grupo;
      if (a.correo) $('#fCorreo').value = a.correo;
    }
    ['#fNombre', '#fMatricula', '#fDeclaro', '#fGrupo'].forEach(function (s) {
      $(s).addEventListener('input', validaPortada);
      $(s).addEventListener('change', validaPortada);
    });
    $('#btnIniciar').addEventListener('click', iniciar);
    $('#btnGenerar').addEventListener('click', generarPDF);
    if ($('#veloBoton')) $('#veloBoton').addEventListener('click', botonVelo);
    $('#btnIrCierre').addEventListener('click', function () {
      $('#bloqueCierre').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    instalaIntegridad();
    validaPortada();

    // Diagnóstico para el profesor: copia de solo lectura del estado (modificarla no altera la sesión).
    window.EXAMEN_DIAG = function () {
      return JSON.parse(JSON.stringify({ estado: estado, politica: POL }));
    };
  });
})();
