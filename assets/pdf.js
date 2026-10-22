/* =====================================================================
   Sinodal — generación del PDF de entrega (jsPDF), derivado del piloto LEM537
   Produce un documento con encabezado institucional, identificación del
   sustentante, enunciados con la variante del alumno, respuestas
   delimitadas para el postproceso y registro de integridad de la sesión.
   ===================================================================== */
window.EXAMEN_PDF = (function () {
  'use strict';

  var AZUL = [27, 42, 99];
  var ROJO = [200, 16, 46];
  var GRIS = [110, 118, 135];
  var GRIS_CLARO = [232, 235, 242];

  // Geometría de página (carta, milímetros)
  var ANCHO = 215.9, ALTO = 279.4;
  var MI = 18, MD = 18, MSUP = 16, MINF = 16;
  var ANCHO_TXT = ANCHO - MI - MD;

  /* Rangos Unicode incluidos en el subconjunto tipográfico embebido. */
  var RANGOS = [[0x09, 0x0A], [0x20, 0x7E], [0xA0, 0xFF], [0x100, 0x17F], [0x192, 0x192],
    [0x370, 0x3FF], [0x2000, 0x206F], [0x2070, 0x209F], [0x20A0, 0x20BF],
    [0x2190, 0x21FF], [0x2200, 0x22FF], [0x2300, 0x2317], [0x25A0, 0x25FF],
    [0x2610, 0x2612], [0xFB00, 0xFB06]];

  function sanea(s) {
    var out = '';
    s = String(s == null ? '' : s);
    for (var i = 0; i < s.length; i++) {
      var c = s.codePointAt(i);
      if (c > 0xFFFF) { i++; out += '?'; continue; }
      var ok = false;
      for (var j = 0; j < RANGOS.length; j++) {
        if (c >= RANGOS[j][0] && c <= RANGOS[j][1]) { ok = true; break; }
      }
      out += ok ? s[i] : '?';
    }
    return out;
  }

  function fmtNum(x) {
    if (typeof x !== 'number') return String(x);
    return String(x).replace('.', ',');
  }

  function iso(ms) { return new Date(ms).toISOString(); }

  // -------------------------------------------------------------- documento
  function Doc(jsPDF, fuentes) {
    this.d = new jsPDF({ unit: 'mm', format: 'letter', orientation: 'portrait', compress: true });
    this.d.addFileToVFS('DejaVuSans.ttf', fuentes.regular);
    this.d.addFont('DejaVuSans.ttf', 'DJV', 'normal');
    this.d.addFileToVFS('DejaVuSans-Bold.ttf', fuentes.bold);
    this.d.addFont('DejaVuSans-Bold.ttf', 'DJV', 'bold');
    this.d.setFont('DJV', 'normal');
    this.y = MSUP;
    this.pagina = 1;
  }

  Doc.prototype.fuente = function (estilo, tam, color) {
    this.d.setFont('DJV', estilo || 'normal');
    this.d.setFontSize(tam || 10);
    var c = color || [40, 45, 60];
    this.d.setTextColor(c[0], c[1], c[2]);
    return this;
  };

  Doc.prototype.espacio = function (mm) { this.y += mm; return this; };

  Doc.prototype.necesita = function (mm) {
    if (this.y + mm > ALTO - MINF) this.nuevaPagina();
    return this;
  };

  Doc.prototype.nuevaPagina = function () {
    this.d.addPage();
    this.pagina++;
    this.y = MSUP;
    return this;
  };

  /* Escribe un bloque de texto con salto de línea automático. */
  Doc.prototype.parrafo = function (txt, opc) {
    opc = opc || {};
    var tam = opc.tam || 9.5;
    var estilo = opc.estilo || 'normal';
    var sangria = opc.sangria || 0;
    var interlinea = opc.interlinea || tam * 0.42;
    var ancho = ANCHO_TXT - sangria - (opc.margenDer || 0);
    this.fuente(estilo, tam, opc.color);
    var lineas = this.d.splitTextToSize(sanea(txt), ancho);
    for (var i = 0; i < lineas.length; i++) {
      this.necesita(interlinea + 2);
      this.d.text(lineas[i], MI + sangria, this.y);
      this.y += interlinea;
    }
    if (opc.despues) this.y += opc.despues;
    return this;
  };

  Doc.prototype.linea = function (grosor, color) {
    var c = color || GRIS_CLARO;
    this.d.setDrawColor(c[0], c[1], c[2]);
    this.d.setLineWidth(grosor || 0.2);
    this.d.line(MI, this.y, ANCHO - MD, this.y);
    this.y += 1.2;
    return this;
  };

  Doc.prototype.barraTitulo = function (etiqueta, titulo, derecha) {
    this.necesita(14);
    var alto = 7;
    this.d.setFillColor(AZUL[0], AZUL[1], AZUL[2]);
    this.d.rect(MI, this.y, 13, alto, 'F');
    this.d.setFillColor(GRIS_CLARO[0], GRIS_CLARO[1], GRIS_CLARO[2]);
    this.d.rect(MI + 13, this.y, ANCHO_TXT - 13, alto, 'F');

    this.fuente('bold', 9, [255, 255, 255]);
    this.d.text(sanea(etiqueta), MI + 6.5, this.y + 4.9, { align: 'center' });
    this.fuente('bold', 9.5, AZUL);
    this.d.text(sanea(titulo), MI + 16, this.y + 4.9);
    if (derecha) {
      this.fuente('normal', 7.8, GRIS);
      this.d.text(sanea(derecha), ANCHO - MD - 2, this.y + 4.8, { align: 'right' });
    }
    this.y += alto + 3.4;
    return this;
  };

  Doc.prototype.marcador = function (txt) {
    this.necesita(5);
    this.fuente('normal', 6.5, [170, 176, 190]);
    this.d.text(sanea(txt), MI, this.y);
    this.y += 3.1;
    return this;
  };

  Doc.prototype.piePaginas = function (ctx) {
    var total = this.d.getNumberOfPages();
    for (var p = 1; p <= total; p++) {
      this.d.setPage(p);
      this.d.setDrawColor(GRIS_CLARO[0], GRIS_CLARO[1], GRIS_CLARO[2]);
      this.d.setLineWidth(0.3);
      this.d.line(MI, ALTO - MINF + 4, ANCHO - MD, ALTO - MINF + 4);
      this.d.setFont('DJV', 'normal');
      this.d.setFontSize(7.2);
      this.d.setTextColor(GRIS[0], GRIS[1], GRIS[2]);
      this.d.text(sanea(ctx.meta.clave + ' · ' + (ctx.meta.evaluacionCorta || ctx.meta.evaluacion) + ' · ' + ctx.estado.alumno.matricula +
        (ctx.estado.sesion ? ' · Sesión ' + ctx.estado.sesion : '') + ' · Folio ' + ctx.folio), MI, ALTO - MINF + 8);
      this.d.text(sanea('Página ' + p + ' de ' + total), ANCHO - MD, ALTO - MINF + 8, { align: 'right' });
      if (p > 1) {
        this.d.setFontSize(7.2);
        this.d.setTextColor(GRIS[0], GRIS[1], GRIS[2]);
        this.d.text(sanea(ctx.estado.alumno.nombre), MI, MSUP - 6);
        this.d.text(sanea(ctx.meta.materia + ' · ' + ctx.meta.clave), ANCHO - MD, MSUP - 6, { align: 'right' });
        this.d.setDrawColor(GRIS_CLARO[0], GRIS_CLARO[1], GRIS_CLARO[2]);
        this.d.line(MI, MSUP - 4, ANCHO - MD, MSUP - 4);
      }
    }
    return this;
  };

  function textoCierre(e) {
    var c = e.cierre;
    if (!c) return '';
    var ig = e.integridad;
    return c.motivo === 'tiempo'
      ? 'Cerrada por la política de salidas: ' + Math.round(ig.msFuera / 1000) + ' s acumulados fuera de la ventana'
      : 'Cerrada por la política de salidas: ' + ig.salidas + ' salidas de la ventana';
  }

  // ---------------------------------------------------------------- portada
  function portada(doc, ctx) {
    var d = doc.d, e = ctx.estado, m = ctx.meta;

    // Logotipo
    try {
      var anchoLogo = 78;
      d.addImage(window.EXAMEN_LOGO, 'PNG', MI, doc.y, anchoLogo, anchoLogo * (window.EXAMEN_LOGO_ASPECTO || 159 / 760));
      doc.y += anchoLogo * (window.EXAMEN_LOGO_ASPECTO || 159 / 760) + 6;
    } catch (err) { doc.y += 4; }

    d.setDrawColor(AZUL[0], AZUL[1], AZUL[2]);
    d.setLineWidth(0.8);
    d.line(MI, doc.y, ANCHO - MD, doc.y);
    doc.y += 6.5;

    doc.fuente('bold', 16, AZUL);
    d.text(sanea(m.materia), MI, doc.y); doc.y += 6.5;
    doc.fuente('bold', 11.5, ROJO);
    d.text(sanea(m.evaluacion + ' — ' + m.clave), MI, doc.y); doc.y += 5.5;
    doc.fuente('normal', 9.5, GRIS);
    d.text(sanea(m.universidad + ' · ' + m.facultad), MI, doc.y); doc.y += 4.4;
    d.text(sanea(m.programa + ' · ' + m.semestre + ' semestre · Grupo ' + e.alumno.grupo +
      ' · ' + m.periodo), MI, doc.y);
    doc.y += 8;

    // Identificación
    var filas = [
      ['Alumno', e.alumno.nombre],
      ['Matrícula', e.alumno.matricula],
      ['Clave de sesión', e.sesion || '—'],
      ['Correo institucional', e.alumno.correo || '—'],
      ['Profesor', m.profesor],
      ['Alcance evaluado', m.alcance],
      ['Inicio de la sesión', ctx.util.fechaLarga(new Date(e.inicio))],
      ['Término de la sesión', ctx.util.fechaLarga(new Date(e.fin))],
      ['Duración efectiva', ctx.util.hhmmss(e.fin - e.inicio) + '  (referencia: ' + m.duracionMin + ' min)'],
      ['Folio de verificación', ctx.folio],
      ['Versión del instrumento', m.version]
    ];
    if (e.cierre) filas.splice(8, 0, ['Cierre de la sesión', textoCierre(e)]);
    doc.fuente('normal', 8.6);
    var envueltas = filas.map(function (f) {
      return [f[0], d.splitTextToSize(sanea(String(f[1])), ANCHO_TXT - 62)];
    });
    var nLineas = envueltas.reduce(function (a, f) { return a + f[1].length; }, 0);
    var altoTabla = nLineas * 5.0 + (filas.length - 1) * 0.6 + 5;
    d.setFillColor(247, 248, 252);
    d.setDrawColor(GRIS_CLARO[0], GRIS_CLARO[1], GRIS_CLARO[2]);
    d.setLineWidth(0.3);
    d.rect(MI, doc.y, ANCHO_TXT, altoTabla, 'FD');
    doc.y += 5.2;
    envueltas.forEach(function (f) {
      doc.fuente('bold', 8.6, AZUL);
      d.text(sanea(f[0]), MI + 4, doc.y);
      doc.fuente('normal', 8.6, [40, 45, 60]);
      f[1].forEach(function (ln, k) {
        d.text(ln, MI + 54, doc.y + k * 5.0);
      });
      doc.y += f[1].length * 5.0 + 0.6;
    });
    doc.y += 4;

    // Estructura y declaración
    doc.fuente('bold', 9.5, AZUL);
    doc.d.text('Estructura del instrumento', MI, doc.y); doc.y += 4.6;
    doc.parrafo('Sección A — ' + ctx.banco.teoricos.length + ' reactivos de criterio, ' + m.puntosA + ' puntos. Sección B — ' + ctx.banco.numericos.length + ' reactivos ' +
      'numéricos con datos individualizados por matrícula, ' + m.puntosB + ' puntos. Total: ' + (m.puntosA + m.puntosB) + ' puntos. ' +
      'Este documento reproduce íntegramente los enunciados aplicados y las respuestas capturadas por el ' +
      'sustentante; es el único comprobante válido de entrega.', { tam: 8.6, despues: 3 });

    doc.fuente('bold', 9.5, AZUL);
    doc.d.text('Declaración de integridad académica', MI, doc.y); doc.y += 4.6;
    doc.parrafo('☑ El sustentante declaró, antes de iniciar, que resolvería este examen de manera ' +
      'individual, sin asistencia de terceros ni de herramientas de inteligencia artificial, y aceptó ' +
      'el registro de integridad que se documenta al final de este archivo.', { tam: 8.6, despues: 2 });

    doc.espacio(2).linea(0.4, AZUL).espacio(3);
    doc.parrafo('Firma del sustentante: ______________________________________     ' +
      'Fecha: ' + new Date(e.fin).toLocaleDateString('es-MX'), { tam: 8.6, color: GRIS });
  }

  // -------------------------------------------------------------- reactivos
  function seccion(doc, titulo, descripcion) {
    doc.necesita(28);
    doc.espacio(4);
    doc.fuente('bold', 12.5, AZUL);
    doc.d.text(sanea(titulo), MI, doc.y);
    doc.y += 2;
    doc.linea(0.6, AZUL);
    doc.espacio(2.6);
    doc.parrafo(descripcion, { tam: 8.4, color: GRIS, despues: 3 });
  }

  function bloqueRespuesta(doc, texto, vacio) {
    var t = (texto || '').trim();
    doc.fuente('bold', 8.4, AZUL);
    doc.necesita(6);
    doc.d.text('Respuesta del sustentante', MI, doc.y);
    doc.y += 4.2;
    if (!t) {
      doc.parrafo('[SIN RESPUESTA]', { tam: 9, estilo: 'bold', color: ROJO, despues: 1 });
      return;
    }
    // Se respetan los saltos de línea capturados por el alumno
    t.split(/\r?\n/).forEach(function (p) {
      if (!p.trim()) { doc.espacio(1.6); return; }
      doc.parrafo(p, { tam: 9, interlinea: 4.2 });
    });
    doc.espacio(1);
  }

  function reactivosTeoricos(doc, ctx) {
    ctx.banco.teoricos.forEach(function (r, i) {
      var num = 'A' + (i + 1 < 10 ? '0' : '') + (i + 1);
      doc.necesita(40);
      doc.barraTitulo(num, r.titulo, r.puntos + ' pts · ' + r.tema);
      r.texto.forEach(function (l) {
        var esInciso = /^\((i|ii|iii|iv|v)\)/.test(l.trim());
        doc.parrafo(l, { tam: 8.8, sangria: esInciso ? 6 : 0, interlinea: 4.0 });
      });
      doc.espacio(2);
      doc.marcador('[[R:' + r.id + ']]');
      bloqueRespuesta(doc, ctx.estado.resp[r.id]);
      doc.marcador('[[/R:' + r.id + ']]');
      doc.espacio(3.5);
    });
  }

  function reactivosNumericos(doc, ctx, letra) {
    var V = window.EXAMEN_VAR;
    letra = letra || 'B';
    var lista = letra === 'C' ? (ctx.banco.analisis || []) : ctx.banco.numericos;
    lista.forEach(function (r, i) {
      var num = letra + (i + 1 < 10 ? '0' : '') + (i + 1);
      var vars = ctx.estado.variantes[r.id] || V.resolver(r, ctx.estado.alumno.matricula, ctx.estado.sesion);
      var resp = ctx.estado.resp[r.id] || {};

      doc.necesita(48);
      doc.barraTitulo(num, r.titulo, r.puntos + ' pts · ' + r.tema);
      r.texto.forEach(function (l) {
        doc.parrafo(V.texto(l, vars), { tam: 8.8, interlinea: 4.0 });
      });
      doc.espacio(1.5);

      // Datos de la variante (auditoría)
      var datos = Object.keys(vars).filter(function (k) { return !/\d$/.test(k) || !(k.replace(/\d$/, '') in vars); })
        .map(function (k) { return k + '=' + (Array.isArray(vars[k]) ? vars[k].join('/') : fmtNum(vars[k])); })
        .join('; ');
      doc.marcador('[[V:' + r.id + ']] ' + datos + ' [[/V:' + r.id + ']]');

      // Valores reportados
      doc.fuente('bold', 8.4, AZUL);
      doc.necesita(6);
      doc.d.text('Valores reportados', MI, doc.y);
      doc.y += 4.2;
      doc.marcador('[[R:' + r.id + ']]');
      r.campos.forEach(function (c) {
        var v = String(resp[c.k] == null ? '' : resp[c.k]).trim();
        doc.fuente('normal', 9, v ? [40, 45, 60] : ROJO);
        doc.necesita(5);
        doc.d.text(sanea(c.k + ' = ' + (v || '[VACÍO]') + '   ' + c.u + '   (' + c.et + ')'), MI + 4, doc.y);
        doc.y += 4.4;
      });
      var esC = letra === 'C';
      var cr = String((esC ? resp.analisis : resp.criterio) || '').trim();
      doc.fuente('bold', 8.4, AZUL);
      doc.necesita(6);
      doc.d.text(esC ? 'ANÁLISIS:' : 'CRITERIO:', MI + 4, doc.y);
      doc.y += 4.2;
      if (cr) {
        doc.parrafo(cr, { tam: 8.8, sangria: 4, interlinea: 4.0 });
      } else {
        doc.parrafo(esC ? '[SIN ANÁLISIS]' : '[SIN CRITERIO DECLARADO]', { tam: 8.8, estilo: 'bold', color: ROJO, sangria: 4 });
      }
      doc.marcador('[[/R:' + r.id + ']]');
      doc.espacio(3.5);
    });
  }

  // ------------------------------------------------------------- integridad
  function registroIntegridad(doc, ctx) {
    var e = ctx.estado, ig = e.integridad;
    doc.nuevaPagina();
    doc.fuente('bold', 12.5, AZUL);
    doc.d.text('Registro de integridad de la sesión', MI, doc.y);
    doc.y += 2; doc.linea(0.6, AZUL); doc.espacio(3);

    doc.parrafo('Registro automático generado por la aplicación del examen y aceptado por el sustentante ' +
      'en la declaración inicial. Los indicadores no constituyen por sí mismos una imputación: son datos ' +
      'de sesión que el profesor contrasta con el contenido técnico de las respuestas.',
      { tam: 8.2, color: GRIS, despues: 3 });

    var filas = [
      ['Duración efectiva de la sesión', ctx.util.hhmmss(e.fin - e.inicio)],
      ['Eventos de copiado al portapapeles', String(ig.copias) + '  (' + ig.caracteresCopiados + ' caracteres)'],
      ['Eventos de pegado en campos de respuesta', String(ig.pegados) + '  (' + ig.caracteresPegados + ' caracteres)'],
      ['Salidas de la ventana del examen', String(ig.salidas)],
      ['Tiempo acumulado fuera de la ventana', ctx.util.hhmmss(ig.msFuera)],
      ['Pérdidas breves de foco (menos de 2 s)', String(ig.focosBreves || 0)],
      ['Salidas de la pantalla completa', String(ig.fsSalidas || 0)],
      ['Política al salir de la ventana', ctx.util.politica()],
      ['Sesiones anteriores en este navegador', String(e.reinicios || 0) +
        (e.previas && e.previas.length ? '  (' + e.previas.slice(-3).join(', ') + (e.previas.length > 3 ? ', …' : '') + ')' : '')],
      ['Cierre de la sesión', e.cierre ? textoCierre(e) : 'por el sustentante'],
      ['Marcas de trazabilidad detectadas', ig.canarios.length ? ig.canarios.join(', ') : 'ninguna']
    ];
    var alto = filas.length * 5.6 + 4;
    doc.d.setFillColor(247, 248, 252);
    doc.d.setDrawColor(GRIS_CLARO[0], GRIS_CLARO[1], GRIS_CLARO[2]);
    doc.d.rect(MI, doc.y, ANCHO_TXT, alto, 'FD');
    doc.y += 5.4;
    filas.forEach(function (f) {
      doc.fuente('bold', 8.6, AZUL);
      doc.d.text(sanea(f[0]), MI + 4, doc.y);
      doc.fuente('normal', 8.6, f[1] === 'ninguna' || f[0].indexOf('Marcas') < 0 ? [40, 45, 60] : ROJO);
      doc.d.text(sanea(f[1]), MI + 96, doc.y);
      doc.y += 5.6;
    });
    doc.espacio(5);

    if (ig.eventos && ig.eventos.length) {
      doc.fuente('bold', 9.5, AZUL);
      doc.necesita(8);
      doc.d.text('Bitácora cronológica (t = tiempo desde el inicio)', MI, doc.y);
      doc.y += 4.6;
      var lineas = ig.eventos.slice(0, 120).map(function (ev) {
        return ctx.util.hhmmss(ev.t) + '  ' + ev.tipo + (ev.det ? '  ' + ev.det : '');
      });
      lineas.forEach(function (l) {
        doc.fuente('normal', 7.4, GRIS);
        doc.necesita(4);
        doc.d.text(sanea(l), MI + 3, doc.y);
        doc.y += 3.4;
      });
      if (ig.eventos.length > 120) {
        doc.parrafo('… y ' + (ig.eventos.length - 120) + ' eventos adicionales.', { tam: 7.4, color: GRIS });
      }
      doc.espacio(4);
    }

    // Bloque legible por máquina para el postproceso
    doc.necesita(50);
    doc.fuente('bold', 9.5, AZUL);
    doc.d.text('Bloque de datos para el procesamiento automático', MI, doc.y);
    doc.y += 4.6;
    var meta = [
      'matricula=' + e.alumno.matricula,
      'nombre=' + e.alumno.nombre,
      'grupo=' + e.alumno.grupo,
      'correo=' + (e.alumno.correo || ''),
      'sesion=' + (e.sesion || ''),
      'reinicios=' + (e.reinicios || 0),
      'previas=' + ((e.previas || []).slice(-6).join(',')),
      'cierre=' + (e.cierre ? e.cierre.motivo : 'ninguno'),
      'politica_salida=' + ctx.util.politica(),
      'inicio=' + iso(e.inicio),
      'fin=' + iso(e.fin),
      'duracion_s=' + Math.round((e.fin - e.inicio) / 1000),
      'copias=' + ig.copias,
      'car_copiados=' + ig.caracteresCopiados,
      'pegados=' + ig.pegados,
      'car_pegados=' + ig.caracteresPegados,
      'salidas=' + ig.salidas,
      'seg_fuera=' + Math.round(ig.msFuera / 1000),
      'fs_salidas=' + (ig.fsSalidas || 0),
      'focos_breves=' + (ig.focosBreves || 0),
      'canarios=' + (ig.canarios.join(',') || 'ninguno'),
      'folio=' + ctx.folio,
      'version=' + ctx.meta.version,
      'agente=' + (navigator.userAgent || '').slice(0, 90)
    ];
    doc.marcador('[[META]]');
    meta.forEach(function (l) {
      doc.fuente('normal', 7.4, [90, 96, 112]);
      doc.necesita(4);
      doc.d.text(sanea(l), MI + 3, doc.y);
      doc.y += 3.5;
    });
    doc.marcador('[[/META]]');

    doc.espacio(4);
    doc.parrafo('Fin del documento. Entregue este archivo, sin modificarlo ni renombrarlo, en la tarea ' +
      'correspondiente de ' + (ctx.meta.plataforma || 'la plataforma del curso') + '.', { tam: 8.2, estilo: 'bold', color: AZUL });
  }

  // ------------------------------------------------------------------ API
  function generar(ctx) {
    var jsPDFctor = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    if (!jsPDFctor) throw new Error('No se cargó la biblioteca de generación de PDF (vendor/jspdf.umd.min.js).');
    if (!window.EXAMEN_FUENTES) throw new Error('No se cargaron las fuentes tipográficas (assets/fuentes.js).');

    var doc = new Doc(jsPDFctor, window.EXAMEN_FUENTES);
    var e = ctx.estado;

    doc.d.setProperties({
      title: ctx.meta.clave + ' ' + (ctx.meta.evaluacionCorta || ctx.meta.evaluacion) + ' — ' + e.alumno.matricula,
      subject: ctx.meta.materia + ' · ' + ctx.meta.evaluacion + ' · Folio ' + ctx.folio,
      author: e.alumno.nombre,
      keywords: [ctx.meta.clave, e.alumno.matricula, e.alumno.grupo, ctx.folio, 'sesion:' + (e.sesion || ''),
        'canarios:' + (e.integridad.canarios.join('|') || 'ninguno'),
        'duracion_s:' + Math.round((e.fin - e.inicio) / 1000)].join(', '),
      creator: 'Sinodal · ' + ctx.meta.clave + ' v' + ctx.meta.version
    });

    portada(doc, ctx);

    var teoria = ctx.meta.estiloA !== 'criterio';
    var ptsA = fmtNum(+(ctx.meta.puntosA / Math.max(1, ctx.banco.teoricos.length)).toFixed(2));
    if (ctx.banco.teoricos.length) {
      doc.nuevaPagina();
      seccion(doc, teoria ? 'Sección A · Teoría' : 'Sección A · Reactivos de criterio', teoria
        ? ctx.banco.teoricos.length + ' preguntas conceptuales de respuesta breve, ' + ptsA + ' puntos cada una. Se ' +
          'evalúan la idea central, su explicación y su aplicación o condición de validez.'
        : ctx.banco.teoricos.length + ' reactivos de redacción libre, ' + ptsA + ' puntos cada uno. Se evalúa la decisión de ingeniería ' +
          'y su justificación: hipótesis declaradas, criterio seleccionado con argumento, coherencia física y ' +
          'consecuencias de la decisión.');
      reactivosTeoricos(doc, ctx);
    }

    if (ctx.banco.numericos.length) {
    doc.nuevaPagina();
    seccion(doc, teoria ? 'Sección B · Numérico' : 'Sección B · Reactivos numéricos',
      ctx.banco.numericos.length + ' reactivos con datos individualizados por matrícula' + (e.sesion ? ' y sesión' : '') + ', ' + fmtNum(+(ctx.meta.puntosB / Math.max(1, ctx.banco.numericos.length)).toFixed(2)) + ' puntos cada uno. Se registran los ' +
      'valores reportados, el criterio declarado y los datos de la variante aplicada para su verificación.');
    reactivosNumericos(doc, ctx, 'B');
    }

    var nC = (ctx.banco.analisis || []).length;
    if (nC) {
      doc.nuevaPagina();
      seccion(doc, 'Sección C · Análisis',
        nC + ' casos con datos individualizados, ' + fmtNum(+((ctx.meta.puntosC || 0) / nC).toFixed(2)) + ' puntos cada ' +
        'uno. Se califican los valores calculados y el análisis: el dictamen con base en los propios resultados, ' +
        'el mecanismo que los gobierna y la medida propuesta.');
      reactivosNumericos(doc, ctx, 'C');
    }

    registroIntegridad(doc, ctx);
    doc.piePaginas(ctx);

    doc.d.save(ctx.archivo);
    return ctx.archivo;
  }

  return { generar: generar, sanea: sanea };
})();
