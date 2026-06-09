const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const http = require('http');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const axios = require('axios');

// CAPTURA GLOBAL DE ERRORES EVITA QUE EL BOT MUERA
process.on('unhandledRejection', (err) => {
    const msg = err?.message || err;
    console.log("[UNHANDLED] Error no capturado:", msg);
    // ELIMINADO: La reconexión desde aquí causaba choque de sockets con el evento 'close' nativo de Baileys
});
process.on('uncaughtException', (err) => {
    console.log("[UNCAUGHT] Error crítico:", err?.message || err);
});

// MODULOS EXTERNOS
const cobranza = require('./cobranza');
const marketingModulo = require('./marketing');
const notificador = require('./notificador_local');

// CONFIGURACION
const PORT = process.env.PORT || 10000;

// LISTA DE ADMINISTRADORES
const ADMIN_IDS = ["228621243408492", "97899534934200", "584142531553", "250370957778958", "244362214650069", "60305753296939", "1924162162820", "39058600415402", "58381658247238"];   

const pool = mysql.createPool({
    host: 'one4cars.com',
    user: 'juant200_one4car',
    password: 'Notieneclave1*',
    database: 'juant200_venezon',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const PDF_URL_CATALOGO = "https://www.one4cars.com/sevencorpweb/uploads/precios/Catalogo%20-%20ONE4CARS_compressed.pdf";

const MENU_TEXT = `📋 *MENÚ PRINCIPAL ONE4CARS*

1️⃣ *Medios de pago:* https://www.one4cars.com/medios_de_pago.php/
2️⃣ *Estado de cuenta:* https://www.one4cars.com/estado_de_cuenta.php/
3️⃣ *Lista de precios:* https://www.one4cars.com/lista_de_precios.php/
4️⃣ *Tomar pedido:* https://www.one4cars.com/tomar_pedido.php/
5️⃣ *Mis clientes/Vendedores:* https://www.one4cars.com/mis_clientes.php/
6️⃣ *Afiliar cliente:* https://www.one4cars.com/afiliar_clientes.php/
7️⃣ *Consulta de productos:* https://www.one4cars.com/consulta_productos.php/
8️⃣ *Seguimiento Despacho:* https://www.one4cars.com/despacho.php/
9️⃣ *Asesor Humano:* Indique su duda y un operador revisará el caso pronto.

_Escriba el número de la opción o su consulta directamente._`;

// ===== MAPA DE INTENCIONES REFORMULADO (Para evitar falsos positivos) =====
const MENU_INTENTIONS = {
    '1': {
        keywords: ['medios de pago', 'pago movil', 'datos de pago', 'como pagar', 'datos bancarios', 'cuentas para pagar'],
        response: `1️⃣ *Medios de pago:* https://www.one4cars.com/medios_de_pago.php/`
    },
    '2': {
        keywords: ['estado de cuenta', 'cuanto debo', 'listado de facturas pendiente', 'mi saldo', 'facturas pendientes', 'mi deuda', 'listado de facturas', 'cuentas por cobrar'],
        response: `2️⃣ *Estado de cuenta:* https://www.one4cars.com/estado_de_cuenta.php/`
    },
    '3': {
        keywords: ['lista de precios', 'listado de precios', 'catalogo de precios', 'cuanto cuestan' , 'pasame la lista', 'ver precios'],
        response: `3️⃣ *Lista de precios:* https://www.one4cars.com/lista_de_precios.php/`
    },
    '4': {
        keywords: ['tomar pedido', 'hacer un pedido', 'quiero comprar', 'realizar pedido'],
        response: `4️⃣ *Tomar pedido:* https://www.one4cars.com/tomar_pedido.php/`
    },
    '5': {
        keywords: ['mis clientes', 'lista de vendedores', 'mis vendedores', 'ver mis clientes'],
        response: `5️⃣ *Mis clientes/Vendedores:* https://www.one4cars.com/mis_clientes.php/`
    },
    '6': {
        keywords: ['afiliar cliente', 'registrar cliente', 'dar de alta cliente', 'nuevo cliente'],
        response: `6️⃣ *Afiliar cliente:* https://www.one4cars.com/afiliar_clientes.php/`
    },
    '7': {
        keywords: ['consulta de productos', 'buscar en inventario', 'ver disponibilidad',  'saber de sus productos', 'buscar repuesto'],
        response: `7️⃣ *Consulta de productos:* https://www.one4cars.com/consulta_productos.php/`
    },
    '8': {
        keywords: ['seguimiento despacho', 'donde esta mi pedido', 'estatus del envio', 'rastrear pedido'],
        response: `8️⃣ *Seguimiento Despacho:* https://www.one4cars.com/despacho.php/`
    },
    '9': {
        keywords: ['asesor humano', 'hablar con un operador', 'soporte humano', 'quiero hablar con alguien', 'ayuda de un operador'],
        response: `9️⃣ *Asesor Humano:* Indique su duda y un operador revisará el caso pronto. 👩‍💻`
    }
};

let qrCodeData = "Iniciando...";
let socketBot = null;
let dolarInfo = { bcv: 'Cargando...', paralelo: 'Cargando...', binance: 'Cargando...' };
let notificadorInterval = null;
const pendientesConfirmacion = new Map();
let isStartingBot = false; // CANDADO DE PREVENCION DE RECONEXION MULTIPLE

// ===== FUNCIONES DE APOYO =====

function normalizar(texto) {
    return texto
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") 
        .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?!]/g, "") 
        .toLowerCase()
        .trim();
}

function limpiarRIF(texto) {
    return texto.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function soloNumerosRIF(texto) {
    return texto.replace(/\D/g, '');
}

async function safeSendMessage(jid, content) {
    try {
        if (!socketBot) throw new Error("Socket no inicializado");
        await socketBot.sendMessage(jid, content);
        console.log(`[MSG] ✅ Mensaje enviado a ${jid}`);
    } catch (e) {
        console.log(`[MSG] ❌ Error enviando mensaje:`, e.message);
    }
}

function isBotReady() {
    return socketBot && socketBot.user && socketBot.user.id;
}

function formatWhatsApp(jid) {
    if (!jid) return null;
    if (jid.toString().includes('@')) return jid;
    let clean = jid.toString().replace(/\D/g, ''); 
    if (clean.startsWith('580')) { clean = '58' + clean.substring(3); }
    if (clean.length > 15) return `${clean}@lid`;
    if (clean.startsWith('0')) clean = clean.substring(1);
    if (!clean.startsWith('58')) clean = '58' + clean;
    return `${clean}@s.whatsapp.net`;
}

const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const randomDelay = async () => {
    const ms = Math.floor(Math.random() * (25000 - 15000 + 1)) + 15000; 
    await sleep(ms);
};

async function guardarMensaje(tel, rol, contenido) {
    try {
        await pool.execute("INSERT INTO historial_chat (telefono, rol, contenido) VALUES (?, ?, ?)", [tel, rol, contenido]);
    } catch (e) { console.log("Error guardando historial"); }
}

async function setModo(tel, modo) {
    await pool.execute("INSERT INTO control_chat (telefono, modo) VALUES (?, ?) ON DUPLICATE KEY UPDATE modo = VALUES(modo)", [tel, modo]);
}

async function buscarVendedor(jid, pushName) {
    const telLimpio = jid.split('@')[0].replace(/\D/g, ''); 
    const [r] = await pool.execute(
        "SELECT * FROM tab_vendedores WHERE REPLACE(REPLACE(celular_vendedor, ' ', ''), '+', '') LIKE ? OR REPLACE(REPLACE(telefono_vendedor, ' ', ''), '+', '') LIKE ? LIMIT 1", 
        [`%${telLimpio}%`, `%${telLimpio}%`]
    );
    if (r[0]) return r[0];
    const jidDomain = jid.split('@')[1];
    if (jidDomain && jidDomain.includes('lid') && pushName) {
        const [r2] = await pool.execute(
            "SELECT * FROM tab_vendedores WHERE nombre LIKE ? LIMIT 1",
            [`%${pushName}%`]
        );
        if (r2[0]) return r2[0];
    }
    return null;
}

function detectarIntencionMenu(texto) {
    if (!texto) return null;
    if (/^\d$/.test(texto)) {
        const num = texto.charAt(0);
        if (MENU_INTENTIONS[num]) return MENU_INTENTIONS[num].response;
    }
    for (const key in MENU_INTENTIONS) {
        const intention = MENU_INTENTIONS[key];
        if (intention.keywords.some(phrase => texto.includes(phrase))) {
            return intention.response;
        }
    }
    return null;
}

// ===== BASE DE DATOS =====
async function initDB() {
    try {
        await pool.execute(`CREATE TABLE IF NOT EXISTS control_chat (
            telefono VARCHAR(100) PRIMARY KEY, 
            usuario VARCHAR(50), 
            id_cliente_int INT,
            modo VARCHAR(20) DEFAULT 'bot', 
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);
        
        await pool.execute(`CREATE TABLE IF NOT EXISTS historial_chat (
            id INT AUTO_INCREMENT PRIMARY KEY, 
            telefono VARCHAR(100), 
            rol ENUM('user', 'model'), 
            contenido TEXT, 
            fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);

        await pool.execute(`CREATE TABLE IF NOT EXISTS recordatorios_log (
            id INT AUTO_INCREMENT PRIMARY KEY,
            id_factura INT NOT NULL,
            nivel INT NOT NULL,
            fecha_envio TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uk_recordatorio (id_factura, nivel)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);

        await pool.execute(`CREATE TABLE IF NOT EXISTS envio_vendedor_log (
            id INT AUTO_INCREMENT PRIMARY KEY,
            fecha_envio DATE NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);

        await pool.execute(`CREATE TABLE IF NOT EXISTS envio_estadisticas_log (
            id INT AUTO_INCREMENT PRIMARY KEY,
            fecha_envio DATE NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);
        
        console.log("✅ Base de Datos vinculada.");
    } catch (e) { console.log("❌ Error DB Init:", e.message); }
}

async function getSesion(jid) {
    const [r] = await pool.execute("SELECT * FROM control_chat WHERE telefono=?", [jid]);
    return r[0] || null;
}

async function guardarUsuario(jid, usuario, id_int) {
    await pool.execute(`
        INSERT INTO control_chat (telefono, usuario, id_cliente_int, modo) 
        VALUES (?, ?, ?, 'bot') 
        ON DUPLICATE KEY UPDATE usuario=VALUES(usuario), id_cliente_int=VALUES(id_cliente_int), modo='bot'
    `, [jid, usuario, id_int]);
}

async function buscarCliente(rifLimpio) {
    const soloNum = soloNumerosRIF(rifLimpio);
    const [r] = await pool.execute(
        "SELECT id_cliente, nombres, celular, cedula, direccion, zona FROM tab_clientes WHERE clave = ? OR clave = ? OR clave LIKE ? LIMIT 1", 
        [rifLimpio, soloNum, `%${rifLimpio}%`]
    );
    return r[0] || null;
}

async function obtenerPorcentaje() {
    try {
        const [r] = await pool.execute("SELECT porcentaje FROM tab_porcentaje LIMIT 1");
        if (r.length > 0) {
            console.log("[PORCENTAJE] Valor obtenido:", r[0].porcentaje);
            return parseFloat(r[0].porcentaje) || 1;
        }
        console.log("[PORCENTAJE] tabla vacia, se usara 1");
    } catch (e) {
        console.log("[PORCENTAJE] Error consultando tab_porcentajes:", e.message);
    }
    return 1;
}

async function buscarProductoPorCodigo(codigo) {
    const codLimpio = codigo.trim();
    try {
        const sql = `SELECT producto, descripcion, tipo, precio_minimo, (cantidad_existencia + cantidad_existencia_almacen) as stock_total, cantidad_fabricando FROM tab_productos WHERE producto = ? LIMIT 1`;
        const [rows] = await pool.execute(sql, [codLimpio]);
        if (rows.length > 0) return rows;
    } catch (e) {
        console.log("Error buscando por código exacto:", e.message);
    }
    return null;
}

async function obtenerTop10() {
    try {
        const sql = `SELECT r.producto, p.descripcion, p.precio_minimo, SUM(r.cantidad) as total_vendido FROM tab_facturas_reng r JOIN tab_facturas f ON f.nro_factura = r.id_factura JOIN tab_productos p ON p.producto = r.producto WHERE f.fecha_reg >= DATE_FORMAT(CURDATE(), '%Y-%m-01') AND f.anulado = 'no' GROUP BY r.producto ORDER BY total_vendido DESC LIMIT 10`;
        const [rows] = await pool.execute(sql);
        if (rows.length > 0) return rows;
    } catch (e) { console.log("Error Top10 id_factura:", e.message); }
    try {
        const sql = `SELECT r.producto, p.descripcion, p.precio_minimo, SUM(r.cantidad) as total_vendido FROM tab_facturas_reng r JOIN tab_facturas f ON f.nro_factura = r.id_facturas JOIN tab_productos p ON p.producto = r.producto WHERE f.fecha_reg >= DATE_FORMAT(CURDATE(), '%Y-%m-01') AND f.anulado = 'no' GROUP BY r.producto ORDER BY total_vendido DESC LIMIT 10`;
        const [rows] = await pool.execute(sql);
        if (rows.length > 0) return rows;
    } catch (e) { console.log("Error Top10 id_facturas:", e.message); }
    return null;
}

async function buscarProductoPorTexto(texto) {
    // === REEMPLAZO DE MODELOS ESPECÍFICOS SOLICITADOS ===
    let textoBuscado = texto;
    textoBuscado = textoBuscado.replace(/ECOSPORT/gi, "ECO EXPORT");
    textoBuscado = textoBuscado.replace(/GRANCHEROKEE|GRANDCHEROKEE/gi, "GRAND CHEROKEE");
    textoBuscado = textoBuscado.replace(/GRANBLAZER|GRANDVLAZER/gi, "GRAND BLAZER");
    textoBuscado = textoBuscado.replace(/GRANVITARA|GRANDVITARA/gi, "GRAND VITARA");
        textoBuscado = textoBuscado.replace(/SUPER\s*CARRY/gi, "SUPER CARRY");
    const txtNormal = normalizar(textoBuscado);
    // ====================================================

    const stopWords = [
        'tienes', 'la', 'del', 'quiere', 'saber', 'cuanto', 'mide', 'venden', 'donde',
        'precio', 'tienen', 'el', 'una', 'un', 'hay', 'si', 'es', 'de', 'con', 'para',
        'busco', 'hola', 'buenos', 'buenas', 'dias', 'tardes', 'noches', 'como', 'estas',
        'esta', 'familia', 'espero', 'encuentres', 'encuenters', 'bien', 'queria',
        'preguntarte', 'gracias', 'por', 'favor', 'ayuda', 'puedes', 'podrias',
        'quisiera', 'necesito', 'saludos', 'cordial', 'muchas', 'todo', 'bienvenidos',
        'bendiciones', 'exito', 'exitos', 'dia', 'tarde', 'noche', 'pregunta', 'consulta',
        'atento', 'atenta', 'saludo', 'estimados', 'estimado', 'buen', 'buena', 'bueno',
        'se', 'me', 'le', 'te', 'lo', 'los', 'las', 'les', 'su', 'sus', 'mi', 'mis',
        'tu', 'tus', 'nos', 'os', 'que', 'cual', 'cuales', 'quien', 'quienes',
        'cuando', 'porque', 'pues', 'pero', 'mas', 'muy', 'asi', 'aun', 'entre', 'sin',
        'sobre', 'tras', 'durante', 'mediante', 'excepto', 'segun', 'puede', 'puedo',
        'pueden', 'podemos', 'podria', 'hacer', 'hace', 'hacen', 'ser', 'estar', 'tener',
        'tengo', 'tenemos', 'tiene', 'decir', 'dice', 'dicen', 'digo', 'ver', 'veo',
        'ven', 'vez', 'veces', 'quiero', 'quiere', 'quieren', 'queremos', 'gustaria',
        'gusta', 'gustan', 'gusto', 'necesita', 'necesitan', 'necesitamos', 'pueda','UNID.','unid.','unidades','unidad','UNIDADES','unidades',
        'puedas', 'pudiera', 'pudieras', 'listo', 'claro', 'ok', 'okey', 'vale', 'va',
        'vamos', 'vaya', 'algun', 'alguna', 'algunos', 'algunas', 'ningun', 'ninguna',
        'tipo', 'tipos', 'preguntar', 'disculpa', 'disculpe', 'permiso', 'ayudar',
        'apoyo', 'consulta', 'consultar', 'info', 'informacion', 'decirme', 'dime',
        'avísame', 'avisa', 'saber', 'sabes', 'saben', 'sabemos',
        'pana', 'panas', 'brother', 'bro', 'amigo', 'amigos', 'compa', 'compadre',
        'ando', 'andas', 'andan', 'andaba', 'andabas', 'andabamos', 'andaban',
        'estoy', 'estas', 'esta', 'estaba', 'estabas', 'estabamos', 'estaban',
        'vengo', 'vienes', 'viene', 'vienen', 'venia', 'venias', 'veniamos', 'venian',
        'voy', 'vas', 'va', 'vamos', 'van', 'iba', 'ibas', 'ibamos', 'iban',
        'llegando', 'pais', 'país', 'atento',
        'enviaras', 'existencia', 'existencias', 'enviar', 'enviame', 'mandame', 'mándame', 
        'envíame', 'disponibilidad', 'ver', 'buscar', 'repuesto', 'repuestos', 'catalogo', 'catálogo',
        'tendra', 'tendras', 'tendran', 'tendria', 'tendrias', 'tendrian', 'tendriamos','tendremos'
    ];

    const palabrasBase = txtNormal.split(' ')
        .filter(p => p.length > 2 && !stopWords.includes(p));

    if (palabrasBase.length === 0) return null;

    const positionalWords = ['superior', 'sup', 'inferior', 'inf', 'interno', 'int', 'externo', 'ext', 'derecha', 'der', 'izquierda', 'izq'];
    const isOnlyPositional = palabrasBase.every(p => positionalWords.includes(p));
    if (isOnlyPositional) return null;

    const expandirFormas = (pal) => {
        const f = [pal];
        if (pal.endsWith('es') && pal.length > 4) f.push(pal.slice(0, -2));
        if (pal.endsWith('s') && pal.length > 3 && !pal.endsWith('es')) f.push(pal.slice(0, -1));
        if (!pal.endsWith('s')) {
            f.push(pal + 's');
            if (pal.endsWith('z')) f.push(pal.slice(0, -1) + 'ces');
        }
        if (pal.endsWith('a') && pal.length > 4) f.push(pal.slice(0, -1) + 'o');
        if (pal.endsWith('o') && pal.length > 4) f.push(pal.slice(0, -1) + 'a');
        return [...new Set(f)];
    };
    
    let whereClause = "";
    let queryParams = [];

    palabrasBase.forEach((pal, index) => {
        const formas = expandirFormas(pal);
        const conditions = formas.map(() => "descripcion LIKE ?");
        whereClause += `(${conditions.join(" OR ")})`;
        if (index < palabrasBase.length - 1) whereClause += " AND ";
        formas.forEach(f => queryParams.push(`%${f}%`));
    });

    try {
        const sql = `SELECT producto, descripcion, tipo, precio_minimo, (cantidad_existencia + cantidad_existencia_almacen) as stock_total, cantidad_fabricando FROM tab_productos WHERE ${whereClause} LIMIT 8`;
        const [rows] = await pool.execute(sql, queryParams);
        if (rows.length > 0) return rows;
    } catch (e) {
        console.log("Error Intento 1:", e.message);
    }

    let minRelevance = palabrasBase.length;
    if (palabrasBase.length >= 2) {
        minRelevance = Math.max(1, palabrasBase.length - 1);
    }

    const expandedTerms = [...new Set(palabrasBase.flatMap(expandirFormas))];
    const orConditions = expandedTerms.map(() => "descripcion LIKE ?");
    const orParams = expandedTerms.map(p => `%${p}%`);

    const relevanceParts = palabrasBase.map(p => {
        const formas = expandirFormas(p);
        const cases = formas.map(f => `descripcion LIKE '%${f.replace(/[^a-z]/g, '')}%'`);
        return `(CASE WHEN ${cases.join(' OR ')} THEN 1 ELSE 0 END)`;
    });
    const relevanceSQL = relevanceParts.join(' + ');

    try {
        const sqlRelevancia = `
            SELECT producto, descripcion, tipo, precio_minimo, (cantidad_existencia + cantidad_existencia_almacen) as stock_total, cantidad_fabricando
            FROM tab_productos 
            WHERE ${orConditions.join(" OR ")} 
            HAVING (${relevanceSQL}) >= ? 
            ORDER BY ${relevanceSQL} DESC 
            LIMIT 8`;
            
        const [rows] = await pool.execute(sqlRelevancia, [...orParams, minRelevance]);
        if (rows.length > 0) return rows;
    } catch (e) {
        console.log("Error Intento 2:", e.message);
    }

    if (minRelevance > 1 && palabrasBase.length > 1) {
        try {
            const sqlCatchall = `SELECT producto, descripcion, tipo, precio_minimo, (cantidad_existencia + cantidad_existencia_almacen) as stock_total, cantidad_fabricando FROM tab_productos WHERE ${orConditions.join(" OR ")} HAVING (${relevanceSQL}) >= 1 ORDER BY ${relevanceSQL} DESC LIMIT 8`;
            const [rows] = await pool.execute(sqlCatchall, orParams);
            if (rows.length > 0) return rows;
        } catch (e) {
            console.log("Error Intento 3:", e.message);
        }
    }

    return null;
}

async function obtenerDetalleFacturas(id_cliente, id_vendedor = null) {
    let query = `
        SELECT f.id_factura, f.nro_factura, f.total, f.abono_factura, f.fecha_reg, f.porcentaje, f.descuento, f.total_desc,
                c.nombres, c.direccion, c.cedula, c.celular, c.telefono, c.id_cliente, c.zona, c.vendedor as nombre_vendedor
         FROM tab_facturas f
         JOIN tab_clientes c ON f.id_cliente = c.id_cliente
         WHERE f.id_cliente = ? AND f.pagada = 'NO' AND f.anulado = 'no'`;
    let params = [id_cliente];
    if (id_vendedor) { query += ` AND f.id_vendedor = ?`; params.push(id_vendedor); }
    const [facturas] = await pool.execute(query, params);
    return facturas;
}

async function actualizarDolar() {
    try {
        const resOficial = await axios.get('https://ve.dolarapi.com/v1/dolares/oficial', { timeout: 7000 });
        if (resOficial.data) dolarInfo.bcv = parseFloat(resOficial.data.promedio).toFixed(2);
        const resParalelo = await axios.get('https://ve.dolarapi.com/v1/dolares/paralelo', { timeout: 7000 });
        if (resParalelo.data) dolarInfo.paralelo = parseFloat(resParalelo.data.promedio).toFixed(2);
        try {
            const resBinance = await axios.get('https://ve.dolarapi.com/v1/dolares/binance', { timeout: 7000 });
            if (resBinance.data) dolarInfo.binance = parseFloat(resBinance.data.promedio).toFixed(2);
        } catch (e2) {}
    } catch (e) { console.log("Error Dolar API"); }
}

// ===== NOTIFICADOR DE FACTURAS NUEVAS =====
let notificadorEjecutando = false;

async function checkNuevasFacturas() {
    if (!isBotReady() || notificadorEjecutando) return;
    notificadorEjecutando = true;
    try {
        const [facturas] = await pool.execute(
            `SELECT f.id_factura, f.nro_factura, f.nombres, f.celular, f.total, f.abono_factura, f.porcentaje, f.fecha_reg, f.id_cliente, f.id_vendedor,
                    v.celular_vendedor, v.nombre as vendedor_nombre
             FROM tab_facturas f
             LEFT JOIN tab_vendedores v ON f.id_vendedor = v.id_vendedor
             WHERE f.whatsapp_notificado = 'NO' AND f.anulado = 'no' AND f.pagada = 'NO'
             ORDER BY f.id_factura ASC`
        );
        for (const f of facturas) {
            const jid = formatWhatsApp(f.celular);
            if (!jid) continue;
            const fecha = new Date(f.fecha_reg).toISOString().split('T')[0];
            let montoNotif = parseFloat(f.total) / (parseFloat(f.porcentaje) || 1);
            if (f.vendedor_nombre && f.vendedor_nombre.toUpperCase() === 'MANUEL FERRAZ') {
                montoNotif = montoNotif / 0.80;
            }
            const msg = `🧾 *NUEVA FACTURA REGISTRADA*\n\nHola *${f.nombres}*, se ha registrado una nueva factura en nuestro sistema:\n\n🔹 *N°:* ${f.nro_factura}\n🔹 *Monto:* $${montoNotif.toFixed(2)}\n🔹 *Fecha:* ${fecha}\n\nPuede consultar su estado de cuenta en:\nhttps://www.one4cars.com/estado_de_cuenta.php/`;
            await safeSendMessage(jid, { text: msg });

            if (f.celular_vendedor) {
                const jidV = formatWhatsApp(f.celular_vendedor);
                if (jidV) {
                    const msgV = `📢 *NUEVA FACTURA DE SU CLIENTE*\n\nVendedor: *${f.vendedor_nombre || 'N/A'}*\nCliente: *${f.nombres}*\n\n🔹 *N° Factura:* ${f.nro_factura}\n🔹 *Monto:* $${montoNotif.toFixed(2)}\n🔹 *Fecha:* ${fecha}`;
                    await safeSendMessage(jidV, { text: msgV });
                }
            }

            await pool.execute("UPDATE tab_facturas SET whatsapp_notificado = 'SI' WHERE id_factura = ?", [f.id_factura]);
            await sleep(1000);
        }
        if (facturas.length > 0) {
            console.log(`[NOTIFICADOR] ${facturas.length} factura(s) notificada(s).`);
        }
    } catch (e) {
        console.log("[NOTIFICADOR] Error:", e.message);
    } finally {
        notificadorEjecutando = false;
    }
}

// ===== RECORDATORIOS DE FACTURAS VENCIDAS =====
let recordatorioEjecutando = false;

function obtenerNivelRecordatorio(dias) {
    if (dias >= 60) return 60;
    if (dias >= 50) return 50;
    if (dias >= 40) return 40;
    if (dias >= 30) return 30;
    return null;
}

function obtenerTonoMensaje(nivel, f, monto, fecha) {
    if (nivel >= 60) {
        return `🧾 *AVISO DE PAGO PENDIENTE*\n\nHola *${f.nombres}*, la factura *N° ${f.nro_factura}* emitida el *${fecha}* ya superó los 60 días de vencida con un saldo de *$${monto.toFixed(2)}*.\n\nEl retraso en el pago afecta la rotación de nuestros productos y la disponibilidad de inventario para todos nuestros clientes. Le agradecemos realizar el pago a la mayor brevedad posible.\n\nQuedamos a su disposición para cualquier duda o gestión. 🚗`;
    }
    return `🧾 *RECORDATORIO DE PAGO*\n\nHola *${f.nombres}*, le recordamos amablemente que la factura *N° ${f.nro_factura}* con fecha *${fecha}* presenta un saldo pendiente de *$${monto.toFixed(2)}*.\n\nLe agradecemos gestionar el pago para mantener su cuenta al día. Estamos a su disposición para cualquier consulta. 🚗`;
}

async function checkFacturasVencidas() {
    if (!isBotReady() || recordatorioEjecutando) return;
    recordatorioEjecutando = true;
    try {
        const facturas = await notificador.obtenerFacturasVencidas();
        const enviados = await notificador.obtenerRecordatoriosEnviados();
        let cont = 0;

        for (const f of facturas) {
            const dias = f.dias_vencida;
            const nivel = obtenerNivelRecordatorio(dias);
            if (!nivel) continue;

            let monto = (parseFloat(f.total) - parseFloat(f.abono_factura || 0)) / (parseFloat(f.porcentaje) || 1);
            if (f.vendedor_nombre && f.vendedor_nombre.toUpperCase() === 'MANUEL FERRAZ') {
                monto = monto / 0.80;
            }
            if (monto <= 0) continue;

            const fecha = new Date(f.fecha_reg).toISOString().split('T')[0];
            const yaEnviado = enviados[f.id_factura] && enviados[f.id_factura].includes(nivel);
            if (!yaEnviado) {
                const jid = formatWhatsApp(f.celular);
                if (jid) {
                    const msg = obtenerTonoMensaje(nivel, f, monto, fecha);
                    await safeSendMessage(jid, { text: msg });
                }
                await notificador.marcarRecordatorio(f.id_factura, nivel);
                cont++;
                await sleep(1000);
            }
        }

        if (cont > 0) {
            console.log(`[RECORDATORIO] ${cont} cliente(s) notificado(s).`);
        }
    } catch (e) {
        console.log("[RECORDATORIO] Error:", e.message);
    } finally {
        recordatorioEjecutando = false;
    }
}

// ===== RECORDATORIO A VENDEDORES (COBRANZAS) =====
let vendedorEjecutando = false;

async function checkVendedoresRecordatorio(force = false) {
    if (!isBotReady() || vendedorEjecutando) return;
    vendedorEjecutando = true;
    try {
        const hoy = new Date().getDay();
        
        if (!force && (hoy === 0 || hoy === 6)) {
            vendedorEjecutando = false;
            return;
        }

        const ultimo = await notificador.obtenerUltimoEnvioVendedor();
        if (!force && ultimo) {
            const diff = Math.floor((new Date() - new Date(ultimo)) / 86400000);
            if (diff < 3) {
                vendedorEjecutando = false;
                return;
            }
        }

        const facturas = await notificador.obtenerFacturasVencidasAll();
        const vendedoresMap = {};

        for (const f of facturas) {
            const dias = f.dias_vencida;
            if (dias < 30) continue;

            let monto = (parseFloat(f.total) - parseFloat(f.abono_factura || 0)) / (parseFloat(f.porcentaje) || 1);
            if (monto <= 0 || !f.celular_vendedor) continue;

            if (f.vendedor_nombre && f.vendedor_nombre.toUpperCase() === 'MANUEL FERRAZ') {
                monto = monto / 0.80;
            }

            const key = f.celular_vendedor.toString().replace(/\D/g, '');
            if (!vendedoresMap[key]) {
                vendedoresMap[key] = {
                    nombre: f.vendedor_nombre || 'Vendedor',
                    jid: formatWhatsApp(f.celular_vendedor),
                    facturas: []
                };
            }
            vendedoresMap[key].facturas.push(`🔹 *N° ${f.nro_factura}* - ${f.nombres} - $${monto.toFixed(2)} (${dias} días)`);
        }

        for (const key of Object.keys(vendedoresMap)) {
            const v = vendedoresMap[key];
            if (!v.jid || v.facturas.length === 0) continue;
            const msg = `📢 *RESUMEN DE CLIENTES VENCIDOS*\n\nVendedor: *${v.nombre}*\n\n${v.facturas.join('\n')}\n\nLe recordamos la importancia de gestionar estos cobros para mantener la rotación de productos.`;
            await safeSendMessage(v.jid, { text: msg });
            await sleep(1500);
        }

        if (!force) {
            await notificador.marcarEnvioVendedor();
        }
        console.log(`[VENDEDORES] ${Object.keys(vendedoresMap).length} vendedor(es) notificado(s) por cobranzas.`);
    } catch (e) {
        console.log("[VENDEDORES] Error:", e.message);
    } finally {
        vendedorEjecutando = false;
    }
}

// ===== ENVIO DE ESTADISTICAS A CADA VENDEDOR =====
let estadisticasEjecutando = false;

async function checkEstadisticasVendedores(force = false) {
    if (!isBotReady()) {
        console.log("[ESTADISTICAS] Bot no está listo para enviar estadísticas.");
        return;
    }
    // Si se fuerza, ignoramos completamente si está bloqueado
    if (estadisticasEjecutando && !force) {
        console.log("[ESTADISTICAS] Omitido porque ya se encuentra en ejecución.");
        return;
    }
    
    estadisticasEjecutando = true;
    console.log(`[ESTADISTICAS] Iniciando proceso de envío (Force manual: ${force})...`);

    try {
        const hoyDate = new Date();
        const hoyDay = hoyDate.getDay(); 
        const hoyStr = hoyDate.toISOString().split('T')[0];
        
        if (!force) {
            if (hoyDay !== 1) {
                estadisticasEjecutando = false;
                return;
            }
            const [log] = await pool.execute("SELECT id FROM envio_estadisticas_log WHERE fecha_envio = ?", [hoyStr]);
            if (log.length > 0) {
                estadisticasEjecutando = false;
                return;
            }
        }

        // Filtra solo a los vendedores donde el campo 'activo' dice 'SI'
        const [vendedores] = await pool.execute("SELECT id_vendedor, nombre, celular_vendedor, meta_ventas FROM tab_vendedores WHERE activo = 'SI'");

        for (const v of vendedores) {
            if (!v.celular_vendedor) continue;
            const jid = formatWhatsApp(v.celular_vendedor);
            if (!jid) continue;

            let ventaSemana = 0;
            let ventaMes = 0;
            let porcMeta = "0.00";
            const meta = parseFloat(v.meta_ventas || 0);

            try {
                // 1. Venta última semana (7 días)
                const [rSemana] = await pool.execute(
                    "SELECT SUM(total) as total FROM tab_facturas WHERE id_vendedor = ? AND anulado = 'no' AND fecha_reg >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)",
                    [v.id_vendedor]
                );
                ventaSemana = parseFloat(rSemana[0]?.total || 0);

                // 2. Venta mes en curso
                const [rMes] = await pool.execute(
                    "SELECT SUM(total) as total FROM tab_facturas WHERE id_vendedor = ? AND anulado = 'no' AND fecha_reg >= DATE_FORMAT(CURDATE(), '%Y-%m-01')",
                    [v.id_vendedor]
                );
                ventaMes = parseFloat(rMes[0]?.total || 0);

                // 3. Porcentaje de meta
                porcMeta = meta > 0 ? ((ventaMes / meta) * 100).toFixed(2) : "0.00";
            } catch (errDB) {
                console.log(`[ESTADISTICAS] Error calculando totales para ${v.nombre}: ${errDB.message}`);
            }

            // 4. Porcentaje por tipo de producto (Mes en curso)
            let breakdownTexto = "";
            try {
                const [rTipos] = await pool.execute(
                    `SELECT r.tipo, SUM(r.precio_total) as total_tipo 
                     FROM tab_facturas_reng r 
                     JOIN tab_facturas f ON f.nro_factura = r.id_factura
                     WHERE f.id_vendedor = ? AND f.anulado = 'no' AND f.fecha_reg >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
                     GROUP BY r.tipo`,
                    [v.id_vendedor]
                );

                let totalItemsMes = 0;
                rTipos.forEach(row => { totalItemsMes += parseFloat(row.total_tipo || 0); });

                if (rTipos.length === 0) {
                    breakdownTexto = "🔸 _Sin renglones registrados este mes._\n";
                } else {
                    rTipos.forEach(row => {
                        const tTotal = parseFloat(row.total_tipo || 0);
                        const pct = totalItemsMes > 0 ? ((tTotal / totalItemsMes) * 100).toFixed(2) : "0.00";
                        breakdownTexto += `🔸 *${row.tipo || 'General'}:* ${pct}% _($${tTotal.toFixed(2)})_\n`;
                    });
                }
            } catch (errTipos) {
                try {
                    const [rTipos2] = await pool.execute(
                        `SELECT r.tipo, SUM(r.precio_total) as total_tipo 
                         FROM tab_facturas_reng r 
                         JOIN tab_facturas f ON f.nro_factura = r.id_facturas
                         WHERE f.id_vendedor = ? AND f.anulado = 'no' AND f.fecha_reg >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
                         GROUP BY r.tipo`,
                        [v.id_vendedor]
                    );

                    let totalItemsMes2 = 0;
                    rTipos2.forEach(row => { totalItemsMes2 += parseFloat(row.total_tipo || 0); });

                    if (rTipos2.length === 0) {
                        breakdownTexto = "🔸 _Sin renglones registrados este mes._\n";
                    } else {
                        rTipos2.forEach(row => {
                            const tTotal = parseFloat(row.total_tipo || 0);
                            const pct = totalItemsMes2 > 0 ? ((tTotal / totalItemsMes2) * 100).toFixed(2) : "0.00";
                            breakdownTexto += `🔸 *${row.tipo || 'General'}:* ${pct}% _($${tTotal.toFixed(2)})_\n`;
                        });
                    }
                } catch (e2) {
                    console.log(`[ESTADISTICAS] Error desglose productos para ${v.nombre}`);
                    breakdownTexto = "🔸 _Desglose no disponible._\n";
                }
            }

            // 5. TOP MEJORES CLIENTES DEL VENDEDOR (Mes en curso)
            let clientesTexto = "";
            try {
                const [rClientes] = await pool.execute(
                    `SELECT c.nombres, SUM(f.total) as total_cliente 
                     FROM tab_facturas f 
                     JOIN tab_clientes c ON f.id_cliente = c.id_cliente
                     WHERE f.id_vendedor = ? AND f.anulado = 'no' AND f.fecha_reg >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
                     GROUP BY f.id_cliente, c.nombres 
                     ORDER BY total_cliente DESC 
                     LIMIT 3`,
                    [v.id_vendedor]
                );

                if (rClientes.length === 0) {
                    clientesTexto = "🔹 _Sin transacciones registradas este mes._\n";
                } else {
                    rClientes.forEach((row, index) => {
                        clientesTexto += `👑 *${index + 1}. ${row.nombres.trim()}:* $${parseFloat(row.total_cliente).toFixed(2)}\n`;
                    });
                }
            } catch (errClientes) {
                console.log(`[ESTADISTICAS] Error Top Clientes para ${v.nombre}`);
                clientesTexto = "🔹 _Top clientes no disponible._\n";
            }

            // LÓGICA DE MENSAJE MOTIVACIONAL PERSONALIZADO
            let mensajeMotivacional = "";
            const pctNumerico = parseFloat(porcMeta);

            if (ventaMes === 0) {
                const mensajesCero = [
                    `💡 *REFLEXIÓN DE ÉXITO:*\nCada gran logro comienza con un primer paso. Sabemos que el mercado tiene retos, pero tu capacidad es mayor. ¡Esta semana sal a buscar ese primer cierre que cambie la racha! 💪`,
                    `💡 *REFLEXIÓN DE ÉXITO:*\nLas oportunidades están ahí afuera esperando a quien tenga la determinación de tomarlas. Revisa tu estrategia, contacta a tus prospectos y haz que las cosas sucedan. ¡Tú puedes! 🚀`,
                    `💡 *REFLEXIÓN DE ÉXITO:*\nUn arranque lento solo significa que estás tomando impulso. No te desanimes, cada "no" te acerca más a un "sí". ¡A romper el hielo esta semana! 🔥`
                ];
                mensajeMotivacional = mensajesCero[Math.floor(Math.random() * mensajesCero.length)];
            } else if (pctNumerico < 50) {
                const mensajesBajo = [
                    `💡 *REFLEXIÓN DE ÉXITO:*\nVas avanzando, pero sabemos que tu potencial es para mucho más. Concéntrate en visitar a esos clientes indecisos y cerrar las ventas pendientes. ¡Sube el ritmo, la meta te espera! 🏃‍♂️💨`,
                    `💡 *REFLEXIÓN DE ÉXITO:*\nEl éxito es la suma de pequeños esfuerzos repetidos día tras día. Estás en el camino, ahora toca acelerar. ¡Haz que cada visita cuente y mejora esos números! 📈`,
                    `💡 *REFLEXIÓN DE ÉXITO:*\nPara alcanzar metas grandes se requiere un esfuerzo extraordinario. Revisa tus prioridades esta semana y enfócate en los cierres de mayor impacto. ¡Vamos con todo! 💥`
                ];
                mensajeMotivacional = mensajesBajo[Math.floor(Math.random() * mensajesBajo.length)];
            } else if (pctNumerico >= 50 && pctNumerico < 100) {
                const mensajesMedio = [
                    `💡 *REFLEXIÓN DE ÉXITO:*\n¡Excelente trabajo! Ya superaste la mitad del camino. Mantén la disciplina y la energía, estás a un paso de alcanzar tu meta. ¡No bajes el ritmo ahora! 🎯👏`,
                    `💡 *REFLEXIÓN DE ÉXITO:*\nEl esfuerzo está dando frutos y los números lo demuestran. Ahora es el momento del sprint final. ¡Asegura esos cierres y conquista tu objetivo del mes! 🚀🏆`,
                    `💡 *REFLEXIÓN DE ÉXITO:*\n¡Qué buen ritmo llevas! Estás demostrando tu capacidad en el mercado. Mantén el enfoque en tus mejores clientes y asegura llegar al 100%. ¡Tú puedes! 💪✨`
                ];
                mensajeMotivacional = mensajesMedio[Math.floor(Math.random() * mensajesMedio.length)];
            } else {
                const mensajesAlto = [
                    `💡 *REFLEXIÓN DE ÉXITO:*\n¡Felicidades! Has superado tu meta. Tu compromiso y habilidad para cerrar ventas son de otro nivel. Ahora el reto es contigo mismo: ¿qué tan lejos puedes llegar? 🥇🔥`,
                    `💡 *REFLEXIÓN DE ÉXITO:*\n¡Trabajo sobresaliente! Alcanzar el 100% no es fácil, pero tú lo lograste con excelencia. Sigue brillando y demostrando por qué eres uno de los mejores. ¡A romper récords! 🌟🏆`,
                    `💡 *REFLEXIÓN DE ÉXITO:*\n¡Meta superada! Tu dedicación se refleja en estos increíbles números. Disfruta el logro, pero no te detengas, ¡el cielo es el límite para tu talento! 🚀👑`
                ];
                mensajeMotivacional = mensajesAlto[Math.floor(Math.random() * mensajesAlto.length)];
            }

            const msgEstadisticas = `📊 *REPORTE DE ESTADÍSTICAS DE VENTAS*\n\n` +
                `Hola *${v.nombre}*, aquí tienes el resumen de tu rendimiento:\n\n` +
                `📅 *Venta última semana:* $${ventaSemana.toFixed(2)}\n` +
                `📈 *Venta mes en curso:* $${ventaMes.toFixed(2)}\n` +
                `🎯 *Meta asignada:* $${meta.toFixed(2)}\n` +
                `🏁 *Cumplimiento de Meta:* ${porcMeta}%\n\n` +
                `📦 *Ventas por Tipo de Producto (Mes):*\n${breakdownTexto}\n` +
                `🔝 *Tus 3 Mejores Clientes (Mes):*\n${clientesTexto}\n` +
                `${mensajeMotivacional}`;

            await safeSendMessage(jid, { text: msgEstadisticas });
            await sleep(1500); 
        }

        if (!force) {
            await pool.execute("INSERT INTO envio_estadisticas_log (fecha_envio) VALUES (?)", [hoyStr]);
        }
        
        console.log(`[ESTADISTICAS] Reportes individuales enviados correctamente.`);
    } catch (e) {
        console.log("[ESTADISTICAS] Error general:", e.message);
    } finally {
        estadisticasEjecutando = false;
    }
}

// ===== BOT WHATSAPP =====
async function startBot() {
    if (isStartingBot) {
        console.log("[SISTEMA] Intento de reconexión múltiple bloqueado.");
        return;
    }
    isStartingBot = true;

    try {
        if (socketBot) {
            try {
                socketBot.removeAllListeners();
                socketBot.end(undefined);
            } catch (e) {}
            socketBot = null;
        }

        const { state, saveCreds } = await useMultiFileAuthState('auth_info_v2');
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: ["ONE4CARS MASTER", "Chrome", "1.0.0"]
        });

        socketBot = sock;
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (u) => {
            const { connection, lastDisconnect, qr } = u;
            if (qr) qrcode.toDataURL(qr, { scale: 10 }, (_, url) => qrCodeData = url);
            if (connection === 'open') { 
                qrCodeData = "ONLINE ✅"; 
                console.log("🚀 BOT MASTER ONLINE");
                if (!notificadorInterval) {
                    notificadorInterval = setInterval(checkNuevasFacturas, 45000);
                    setInterval(checkFacturasVencidas, 86400000);
                    setInterval(checkVendedoresRecordatorio, 86400000);
                    
                    // Temporizador automático de Estadísticas activado (revisa cada 30 min)
                    setInterval(checkEstadisticasVendedores, 1800000);
                    
                    setInterval(() => {
                        if (!isBotReady() && socketBot && !isStartingBot) startBot();
                    }, 300000);
                }
            }
            if (connection === 'close') {
                const r = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                if (r) setTimeout(() => startBot(), 5000);
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            try {
                if (type !== 'notify') return;
                const msg = messages[0];
                if (!msg.message) return;

                const from = msg.key.remoteJid;
                if (from === 'status@broadcast' || from.includes('@g.us')) return;

                const isAdmin = ADMIN_IDS.some(id => from.includes(id));
                const vendedor = await buscarVendedor(from, msg.pushName || "Vendedor");

                if (msg.key.fromMe) {
                    const textMe = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase();
                    if (textMe === '!bot') {
                        await setModo(from, 'bot');
                        await safeSendMessage(from, { text: "🤖 Bot reactivado para este chat." });
                    } else {
                        await setModo(from, 'humano');
                    }
                    return;
                }

                const pushName = msg.pushName || "Usuario";
                const rawText = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
                if (!rawText) return;

                const text = normalizar(rawText);
                
                const textoLimpioParaRif = rawText.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
                const esRIFPuro = /^[VJGE]\d{8,9}$/.test(textoLimpioParaRif);

                await guardarMensaje(from, 'user', rawText);
                const sesion = await getSesion(from);
                if (sesion && sesion.modo === 'humano' && !isAdmin) return;

                // --- 1. LÓGICA DE RIF (ADMINISTRADORES) ---
                if (esRIFPuro) {
                    if (isAdmin) {
                        const rifLimpio = limpiarRIF(rawText);
                        const c = await buscarCliente(rifLimpio);
                        if (c) {
                            await guardarUsuario(from, rifLimpio, c.id_cliente);
                            const facturas = await obtenerDetalleFacturas(c.id_cliente);
                            let totalP = 0; 
                            let list = `⭐ *CONSULTA DE ESTADO DE CUENTA (ADMIN)*\nCliente: ${c.nombres}\nRIF: ${rifLimpio}\n\n`;
                            if (facturas.length === 0) {
                                list += `✅ Sin facturas pendientes.`;
                            } else {
                                facturas.forEach(f => {
                                    const monto = (f.total - f.abono_factura) / (f.porcentaje || 1);
                                    totalP += monto;
                                    list += `🔸 *#${f.nro_factura}* | $${monto.toFixed(2)}\n`;
                                    list += `✍️ Firmada: https://www.one4cars.com/uploads/notas/${f.nro_factura}.jpg\n\n`;
                                });
                                list += `💰 *TOTAL A PAGAR: $${totalP.toFixed(2)}*`;
                            }
                            return await safeSendMessage(from, { text: list });
                        } else {
                            return await safeSendMessage(from, { text: "❌ No se encontró ningún cliente con ese RIF." });
                        }
                    } else {
                        return await safeSendMessage(from, { text: "❌ La consulta de estado de cuenta mediante RIF es una función exclusiva para administradores." });
                    }
                }

                // --- 2. DETECCIÓN INTELIGENTE DEL MENÚ ---
                const menuOption = detectarIntencionMenu(text);
                if (menuOption) {
                    if (menuOption.includes('Estado de cuenta')) {
                        const targetID = sesion?.id_cliente_int;
                        if (!targetID) {
                            return await safeSendMessage(from, { text: "Para consultar su estado de cuenta, por favor envíe su *RIF* para identificarlo." });
                        }
                        const facturas = await obtenerDetalleFacturas(targetID);
                        if (facturas.length === 0) return await safeSendMessage(from, { text: "✅ No posee facturas pendientes." });
                        let totalP = 0; let listado = "*📄 FACTURAS PENDIENTES:*\n\n";
                        facturas.forEach(f => {
                            const monto = (f.total - f.abono_factura) / (f.porcentaje || 1);
                            totalP += monto;
                            const fReg = new Date(f.fecha_reg).toISOString().split('T')[0];
                            const params = `id_factura=${f.id_factura}&nro_factura=${f.nro_factura}&fecha_reg=${fReg}&total=${f.total}&abono_factura=${f.abono_factura}&nombres=${encodeURIComponent(f.nombres.trim())}&nombre=${encodeURIComponent(f.nombre_vendedor.trim())}&direccion=${encodeURIComponent(f.direccion.trim())}&cedula=${f.cedula.trim()}&celular=${encodeURIComponent(f.celular.trim())}&telefono=${encodeURIComponent(f.telefono.trim())}&id_cliente=${f.id_cliente}&zona=${encodeURIComponent(f.zona.trim())}&descuento=${f.descuento}&total_desc=${f.total_desc}`;
                            listado += `🔸 *#${f.nro_factura}* | $${monto.toFixed(2)}\n📄 PDF: https://one4cars.com/sevencorp/factura_full_reporte_web.php?${params}\n\n`;
                        });
                        listado += `💰 *TOTAL A PAGAR: $${totalP.toFixed(2)}*`;
                        return await safeSendMessage(from, { text: listado });
                    }
                    return await safeSendMessage(from, { text: menuOption });
                }

                // --- 3. LÓGICA DE PAGOS ---
                if (text === 'pago fact' || text === 'abono'  || text.includes('pago') || text.includes('al señor oscar') || text.includes('envié el pago') || text.includes('adjunto pago')) {
                    const nombreUsuario = vendedor ? vendedor.nombre : pushName;
                    const saludoCordial = `¡Hola *${nombreUsuario}*! Gracias por su mensaje. 😊\n\nRecibido tu mensaje, administración validará su pago a la brevedad.\n\n${MENU_TEXT}`;
                    return await safeSendMessage(from, { text: saludoCordial });
                }

                if (text === 'factura fiscal'  || text.includes('factura con iva')  ) {
                    const nombreUsuario = vendedor ? vendedor.nombre : pushName;
                    const saludoCordial = `¡Hola *${nombreUsuario}*! Gracias por su mensaje. 😊\n\nLa Factura Fiscal será realizada de acuerdo con su solicitud el día que tenga disponibilidad de hacer el pago.\n\n${MENU_TEXT}`;
                    return await safeSendMessage(from, { text: saludoCordial });
                }

                // --- CONVERSIÓN DE DIVISAS ---
                const convMatch = text.match(/^(\d+(?:\.\d+)?)\s+a\s+(bcv|paralelo|binance)$/);
                if (convMatch) {
                    const montoUsd = parseFloat(convMatch[1]);
                    const tipo = convMatch[2];
                    const tasa = parseFloat(dolarInfo[tipo] || 0);
                    if (tasa > 0) {
                        const totalBs = montoUsd * tasa;
                        const nombreTasa = tipo === 'bcv' ? 'BCV' : tipo === 'paralelo' ? 'Paralelo' : 'Binance';
                        return await safeSendMessage(from, { text: `💵 *$${montoUsd.toFixed(2)}* × *Bs.${tasa.toFixed(2)}* (${nombreTasa})\n\n🇻🇪 *Total: Bs.${totalBs.toFixed(2)}*` });
                    }
                    return await safeSendMessage(from, { text: `❌ Tasa ${tipo} no disponible. Intente más tarde.` });
                }

                // --- NOTA FIRMADA ---
                const notaMatch = text.match(/^nota\s+(\d+)$/);
                if (notaMatch) {
                    const numNota = notaMatch[1];
                    const linkNota = `https://www.one4cars.com/uploads/notas/${numNota}.jpg`;
                    try {
                        const [f] = await pool.execute("SELECT total, porcentaje FROM tab_facturas WHERE nro_factura = ? LIMIT 1", [numNota]);
                        if (f.length > 0) {
                            const total = parseFloat(f[0].total || 0);
                            const pct = parseFloat(f[0].porcentaje) || 1;
                            const bcv = parseFloat(dolarInfo?.bcv || 0);
                            const monto = bcv > 0 ? (total / pct) * bcv : 0;
                            let msg = `✍️ *Factura Firmada #${numNota}*\n💵 Total USD: $${(total / pct).toFixed(2)}\n`;
                            if (bcv > 0) msg += `🇻🇪 Total Bs: Bs.${monto.toFixed(2)} (tasa BCV: Bs.${bcv.toFixed(2)})`;
                            msg += `\n\n🔗 Ver imagen: ${linkNota}`;
                            return await safeSendMessage(from, { text: msg });
                        }
                    } catch (e) { console.log("[NOTA] Error:", e.message); }
                    return await safeSendMessage(from, { text: `✍️ *Factura Firmada #${numNota}*\n\n🔗 Ver imagen: ${linkNota}` });
                }

                // --- 4. COTIZACIÓN AUTOMÁTICA (MULTILÍNEA) ---
                const lineas = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                const itemsPedido = [];
                for (const linea of lineas) {
                    let match = linea.match(/^\s*([A-Za-z0-9]{3,})(?:\s+[-=]?\s*|[-=]\s*)(\d{1,4})\s*$/);
                    if (match) {
                        itemsPedido.push({ codigo: match[1].toUpperCase(), cantidad: parseInt(match[2]) });
                        continue;
                    }
                    match = linea.match(/^\s*(\d{1,4})(?:\s+[-=]?\s*|[-=]\s*)([A-Za-z0-9]{3,})\s*$/);
                    if (match) {
                        itemsPedido.push({ codigo: match[2].toUpperCase(), cantidad: parseInt(match[1]) });
                        continue;
                    }
                    match = linea.match(/^\s*([A-Za-z0-9]{3,})\s*$/);
                    if (match) {
                        const cod = match[1].toUpperCase();
                        if (/[A-Z]/.test(cod) && /[0-9]/.test(cod)) {
                            itemsPedido.push({ codigo: cod, cantidad: 1 });
                        }
                        continue;
                    }
                    match = linea.match(/^\s*(.+?)\s+[-=]?\s*(\d{1,4})\s*$/);
                    if (match && match[1].length >= 4) {
                        const txtDesc = match[1].trim();
                        const qty = parseInt(match[2]);
                        const prodDesc = await buscarProductoPorTexto(txtDesc);
                        if (prodDesc && prodDesc.length > 0) {
                            itemsPedido.push({ codigo: prodDesc[0].producto, cantidad: qty });
                        }
                    }
                }
                const tieneMultiplesItems = itemsPedido.length >= 2;
                const tieneCantidadExplicita = itemsPedido.length === 1 && itemsPedido[0].cantidad !== 1;
                if (tieneMultiplesItems || tieneCantidadExplicita) {
                    console.log(`[COTIZACION] Detectado pedido de ${itemsPedido.length} items de ${from}`);
                    let itemsOk = [];
                    let errores = [];
                    const pct = await obtenerPorcentaje();
                    for (const item of itemsPedido) {
                        const prods = await buscarProductoPorCodigo(item.codigo);
                        if (!prods || prods.length === 0) {
                            errores.push(`❌ *${item.codigo}*: Código no encontrado`);
                            continue;
                        }
                        const p = prods[0];
                        const stock = parseFloat(p.stock_total || 0);
                        if (stock <= 0) {
                            errores.push(`❌ *${p.producto}*: Sin stock`);
                            continue;
                        }
                        itemsOk.push({ codigo: p.producto, tipo: p.tipo, cantidad: item.cantidad, precio: parseFloat(p.precio_minimo || 0) / pct });
                    }
                    if (itemsOk.length > 0) {
                        const nomCliente = vendedor?.nombre || pushName || 'estimado';
                        const saludoCoti = [
                            `¡Hola *${nomCliente}*! Gracias por su consulta. Aquí tiene la cotización solicitada: 👇`,
                            `Saludos *${nomCliente}*, con gusto le cotizamos. Aquí está el detalle: 👇`,
                            `Buen día *${nomCliente}*, gracias por escribirnos. Le enviamos la cotización: 👇`
                        ][Math.floor(Math.random() * 3)];
                        await safeSendMessage(from, { text: saludoCoti });
                        await sleep(800);
                        let gt = 0;
                        let msg = `📋 *COTIZACIÓN*\n`;
                        if (vendedor) msg += `👤 Vendedor: *${vendedor.nombre}*\n\n`;
                        msg += `💰 *Precios pagaderos a tasa BCV*\n\n`;
                        itemsOk.forEach(it => { const t = it.precio * it.cantidad; gt += t; msg += `*${it.codigo}* - ${it.tipo || ''}\n   ${it.cantidad} und x $${it.precio.toFixed(2)} = *$${t.toFixed(2)}*\n`; });
                        msg += `\n*TOTAL GENERAL: $${gt.toFixed(2)}*`;
                        if (errores.length > 0) msg += `\n\n⚠️ Productos no incluidos:\n${errores.join('\n')}`;
                        await safeSendMessage(from, { text: msg });
                        pendientesConfirmacion.set(from, { items: itemsOk, vendedor: vendedor || null, pushName });
                        await setModo(from, 'confirmando');
                        await sleep(500);
                        await safeSendMessage(from, { text: `✅ *¿Desea confirmar este pedido?*\n\nResponda *SI* para confirmar o *NO* para cancelar.` });
                    } else {
                        let msg = `⚠️ *No se pudo generar la cotización*\n\n${errores.join('\n')}`;
                        await safeSendMessage(from, { text: msg });
                    }
                    return;
                }

                // --- CONFIRMACIÓN DE PEDIDO ---
                if (pendientesConfirmacion.has(from) && sesion && sesion.modo === 'confirmando') {
                    const confWords = ['si', 'sí', 'confirmo', 'confirmar', 'dale', 'ok', 'okey', 'claro', 'simon', 'confirmado', 'yes'];
                    const cancelWords = ['no', 'nop', 'cancelar', 'cancela', 'ninguno', 'nunca'];
                    if (confWords.includes(text)) {
                        const data = pendientesConfirmacion.get(from);
                        try {
                            const hoy = new Date().toISOString().split('T')[0];
                            const [maxNro] = await pool.execute("SELECT COALESCE(MAX(nro_factura),0)+1 as next FROM tab_pedidos");
                            const nro = maxNro[0].next;
                            const jidParts = from.split('@');
                            const rawTel = jidParts[0].replace(/\D/g, '');
                            const isLid = jidParts[1] && jidParts[1].includes('lid');
                            const tel = (isLid || rawTel.length > 13)
                                ? (data.vendedor?.celular_vendedor || `LID:${rawTel}`)
                                : rawTel;
                            const tot = data.items.reduce((s, it) => s + it.precio * it.cantidad, 0);
                            await pool.execute("INSERT INTO tab_pedidos (nro_factura, fecha_reg, nombres, celular, total, id_vendedor, vendedor, celular_vendedor, pagada, anulado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'NO', 'no')",
                                [nro, hoy, data.pushName || 'Cliente', tel, tot, data.vendedor?.id_vendedor || 0, data.vendedor?.nombre || '', data.vendedor?.celular_vendedor || '']);
                            const [pedido] = await pool.execute("SELECT MAX(id_factura) as id FROM tab_pedidos");
                            const idPed = pedido[0].id;
                            for (let i = 0; i < data.items.length; i++) {
                                const it = data.items[i];
                                await pool.execute("INSERT INTO tab_pedidos_reng (id_factura, nro_reglon, producto, cantidad, precio_unitario, precio_total, tipo, fecha_reg) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                                    [idPed, i + 1, it.codigo, it.cantidad, it.precio, it.precio * it.cantidad, it.tipo || '', hoy]);
                            }
                            const adminJids = ADMIN_IDS.map(id => formatWhatsApp(id)).filter(Boolean);
                            for (const aj of adminJids) {
                                await safeSendMessage(aj, { text: `📦 *NUEVO PEDIDO CONFIRMADO #${nro}*\nCliente: ${data.pushName || tel}\nTotal: $${tot.toFixed(2)}\nVendedor: ${data.vendedor?.nombre || 'N/A'}\n\n_Ver pedido en el sistema_` });
                            }
                            await safeSendMessage(from, { text: `✅ *Pedido #${nro} confirmado con éxito!*\n\nUn administrador lo revisará pronto. ¡Gracias por su preferencia! 🙏` });
                        } catch (e) { console.log("[PEDIDO] Error al guardar:", e.message); await safeSendMessage(from, { text: "❌ Ocurrió un error al confirmar el pedido. Intente nuevamente." }); }
                        pendientesConfirmacion.delete(from);
                        await setModo(from, 'bot');
                        return;
                    } else if (cancelWords.includes(text)) {
                        pendientesConfirmacion.delete(from);
                        await setModo(from, 'bot');
                        await safeSendMessage(from, { text: "❌ Pedido cancelado." });
                        return;
                    }
                }

                // --- AGRADECIMIENTO ---
                const gratitudeWords = ['gracias', 'agradecid', 'agardecid', 'agradecimient'];
                if (gratitudeWords.some(w => text.includes(w))) {
                    const nombreUsuario = vendedor ? vendedor.nombre : pushName;
                    const respuestas = [
                        `¡Ha sido un placer atenderle, *${nombreUsuario}*! Que Dios le bendiga y quede muy pendiente cualquier cosita que necesite. Aquí estamos para servirle. 🙏`,
                        `Un honor poder ayudarle, *${nombreUsuario}*. Que tenga un excelente día y cualquier cosita no dude en escribirnos. ¡Estamos a la orden! 🙌`,
                        `Con mucho gusto, *${nombreUsuario}*, para eso estamos. Que Dios le bendiga grandemente y quede muy pendiente. ¡Aquí tiene su casa! 🏠`,
                        `Gracias a usted, *${nombreUsuario}*, por su confianza. Es un privilegio poder atenderle. Que pase un bendecido día. 😊🙏`,
                        `¡De nada, *${nombreUsuario}*! Con todo el gusto del mundo. Recuerde que estamos para servirle en lo que necesite. ¡Dios le bendiga! 🌟`
                    ];
                    const respuesta = respuestas[Math.floor(Math.random() * respuestas.length)];
                    return await safeSendMessage(from, { text: respuesta });
                }

                // --- 5. LÓGICA DE PRODUCTOS MEJORADA ---
                if (text !== 'menu' && !['hola', 'buen dia', 'buenos dias'].includes(text)) {
                    try {
                        let prods = null;
                        
                        const palabrasEnMensaje = rawText.split(/\s+/);
                        for (const p of palabrasEnMensaje) {
                            const codCandidato = p.replace(/[^a-zA-Z0-9]/g, ''); 
                            if (codCandidato.length >= 4) { 
                                prods = await buscarProductoPorCodigo(codCandidato);
                                if (prods) break; 
                            }
                        }
                        
                        if (!prods) {
                            prods = await buscarProductoPorTexto(rawText);
                        }

                        if (prods) {
                            const pct = await obtenerPorcentaje();
                            const saludos = [
                                "Saludos estimado, gracias por tu consulta. Aquí tienes la información solicitada: 👇",
                                "¡Hola! He buscado en nuestro inventario y encontré esto: 👇",
                                "Un placer saludarte. Según lo que me indicas, aquí tienes lo disponible: 👇"
                            ];
                            const saludoAzar = saludos[Math.floor(Math.random() * saludos.length)];
                            await safeSendMessage(from, { text: saludoAzar });
                            await sleep(1000);

                            for (const p of prods) {
                                if (!isBotReady()) break; 
                                const precio = parseFloat(p.precio_minimo || 0) / pct;
                                
                                let infoStock = "";
                                if (parseFloat(p.stock_total || 0) <= 0) {
                                    const fab = parseFloat(p.cantidad_fabricando || 0);
                                    if (fab > 0) {
                                        infoStock = "\n🏭 *EN FÁBRICA (Próximo a llegar)*";
                                    } else {
                                        infoStock = "\n❌ *Sin existencia, solo información*";
                                    }
                                } else {
                                    infoStock = "\n✅ *Disponible*";
                                }
                                
                                const caption = `📦 *CÓDIGO: ${p.producto}*\n💰 *Precio: $${precio.toFixed(2)} (Pagadero a tasa BCV)*${infoStock}\n📝 ${p.descripcion}\n🔗 Ficha: https://one4cars.com/producto_general.php?cod=${p.producto}&tipo=${encodeURIComponent(p.tipo)}`;
                                const imgUrl = `https://one4cars.com/imagen/${p.producto}.jpg`;
                                try {
                                    await socketBot.sendMessage(from, { image: { url: imgUrl }, caption: caption });
                                } catch (imgErr) {
                                    await safeSendMessage(from, { text: caption });
                                }
                                await sleep(1500);
                            }
                            return;
                        }
                    } catch (e) { console.log("Error en flujo de productos:", e); }
                }

                // --- 6. COMANDOS DE ADMINISTRADOR ---
                if (isAdmin) {
                    if (text === 'dolar' || text === 'bcv' || text === 'paralelo' ) {
                        await actualizarDolar();
                        return await safeSendMessage(from, { text: `💵 BCV: ${dolarInfo.bcv}\n📈 Paralelo: ${dolarInfo.paralelo}` });
                    }
                }

                // --- TOP 10 MÁS VENDIDOS ---
                if (text === 'top10' || text === 'top 10' || text === 'mas vendidos' || text === 'top10productos' || text === 'top') {
                    const top10 = await obtenerTop10();
                    if (!top10 || top10.length === 0) {
                        return await safeSendMessage(from, { text: "No hay datos de ventas este mes aún." });
                    }
                    const pct = await obtenerPorcentaje();
                    let msg = `🏆 *TOP 10 MÁS VENDIDOS (MES)*\n💰 *Precios pagaderos a tasa BCV*\n\n`;
                    top10.forEach((p, i) => {
                        const precio = parseFloat(p.precio_minimo || 0) / pct;
                        msg += `${i + 1}. *${p.producto}* - ${p.descripcion}\n`;
                        msg += `   ${p.total_vendido} und | $${precio.toFixed(2)} c/u\n`;
                    });
                    return await safeSendMessage(from, { text: msg });
                }

                // --- 7. SALUDO Y MENÚ ---
                const nombreUsuario = vendedor ? vendedor.nombre : pushName;
                const esSaludo = text === 'menu' || text.startsWith('menu ') ||
                                 text === 'hola' || text.startsWith('hola ') || text.startsWith('hola,') ||
                                 text.startsWith('buen dia ') || text === 'buen dia' ||
                                 text.startsWith('buenos dias ') || text === 'buenos dias' ||
                                 text.startsWith('buenas tardes ') || text === 'buenas tardes' ||
                                 text.startsWith('buenas noches ') || text === 'buenas noches';
                if (esSaludo) {
                    const saludoBase = text.startsWith('buenas tardes') ? 'tarde' :
                                       text.startsWith('buenas noches') ? 'noche' :
                                       text.startsWith('buen') ? 'dia' : 'dia';
                    const respuestas = {
                        'dia': `¡Buenos días, *${nombreUsuario}*! Dios le bendiga. Es un gusto tenerle por aquí. 🙏\n\n¿En qué podemos servirle el día de hoy? Aquí le ayudamos con mucho gusto.\n\n${MENU_TEXT}`,
                        'tarde': `¡Buenas tardes, *${nombreUsuario}*! Un placer saludarle. Que tenga una bendecida tarde. 😊\n\n¿Cómo podemos ayudarle? Quedamos atentos a su solicitud.\n\n${MENU_TEXT}`,
                        'noche': `¡Buenas noches, *${nombreUsuario}*! Dios le bendiga. Que descanse. 🌙\n\n¿En qué podemos ayudarle? Quedamos a la orden.\n\n${MENU_TEXT}`
                    };
                    if (text.startsWith('menu')) {
                        return await safeSendMessage(from, { text: `¡Hola *${nombreUsuario}*! Es un gusto saludarle. 🙌\n\n¿En qué podemos ayudarle hoy? Indíquenos qué servicio necesita o consulte nuestro menú:\n\n${MENU_TEXT}` });
                    }
                    return await safeSendMessage(from, { text: respuestas[saludoBase] });
                }
                
                // --- FALLBACK ---
                const conversationalShorts = ['si', 'no', 'ok', 'vale', 'ya', 'entendido', 'bueno', 'dale', 'claro'];
                if (conversationalShorts.includes(text)) return; 
                if (rawText.length > 500) return;

                return;
            } catch (e) { console.log("[MSG] Error en handler de mensajes:", e.message); }
        });
    } catch (error) {
        console.log("[SISTEMA] Error crítico en el arranque:", error);
    } finally {
        isStartingBot = false;
    }
}

// ===== SERVIDOR HTTP =====
const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const query = Object.fromEntries(parsedUrl.searchParams.entries());
    const header = `<nav class="navbar navbar-dark bg-dark mb-4 shadow"><div class="container"><a class="navbar-brand fw-bold" href="/">ONE4CARS ADMIN</a></div></nav>`;
    const routename = parsedUrl.pathname;

    if (routename === '/cobranza') {
        const v = await cobranza.obtenerVendedores();
        const z = await cobranza.obtenerZonas();
        const d = await cobranza.obtenerListaDeudores(query);
        res.end(await cobranza.generarHTML(v, z, d, header, query));
    } else if (routename === '/marketing-panel') {
        const v = await marketingModulo.obtenerVendedores();
        const z = await marketingModulo.obtenerZonas();
        const c = await marketingModulo.obtenerClientesMarketing(query);
        res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
        res.end(await marketingModulo.generarHTMLMarketing(c, v, z, header, query));
    } else if (routename === '/marketing-preview') {
        let sql = "SELECT id_cliente, nombres, celular FROM tab_clientes WHERE celular IS NOT NULL AND celular != ''";
        const params = [];
        if (query.vendedor) { sql += " AND vendedor = ?"; params.push(query.vendedor); }
        if (query.zona) { sql += " AND zona = ?"; params.push(query.zona); }
        const [clientes] = await pool.execute(sql, params);
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(clientes));
    } else if (routename === '/enviar-marketing' && req.method === 'POST') {
        if (!isBotReady()) return res.end("Bot no listo.");
        let b = ''; req.on('data', c => b += c);
        req.on('end', async () => {
            const data = JSON.parse(b);
            for (const id of data.clientes) {
                const [rows] = await pool.execute("SELECT * FROM tab_clientes WHERE id_cliente=?", [id]);
                if (rows[0]) {
                    const c = rows[0];
                    const jid = formatWhatsApp(c.celular);
                    try {
                        if (data.tipo === 'precios') {
                            await safeSendMessage(jid, { document: { url: PDF_URL_CATALOGO }, fileName: 'Catalogo-ONE4CARS.pdf', mimetype: 'application/pdf', caption: `¡Hola *${c.nombres}*! Catálogo actualizado.` });
                        } else if (data.tipo === 'promo') {
                            await safeSendMessage(jid, { text: data.mensaje });
                        }
                        await randomDelay();
                    } catch (e) {}
                }
            }
            res.end("OK");
        });
    } else if (routename === '/enviar-cobranza' && req.method === 'POST') {
        if (!isBotReady()) return res.end("Bot no listo.");
        let b = ''; req.on('data', c => b += c);
        req.on('end', async () => {
            const data = JSON.parse(b);
            for (const id_cliente of data.facturas) {
                const [facturas] = await pool.execute(
                    "SELECT f.nro_factura, f.total, f.abono_factura, f.fecha_reg, f.porcentaje, c.nombres, c.celular FROM tab_facturas f JOIN tab_clientes c ON f.id_cliente = c.id_cliente WHERE f.id_cliente = ? AND f.pagada = 'NO' AND f.anulado = 'no'", 
                    [id_cliente]
                );
                for (const f of facturas) {
                    const jid = formatWhatsApp(f.celular);
                    const saldoBs = (f.total - f.abono_factura) / (f.porcentaje || 1);
                    const msg = `Hola *${f.nombres}* 🚗, factura #${f.nro_factura} pendiente.\nSaldo: Bs. *${saldoBs.toLocaleString('es-VE')}*.\nPor favor gestione su pago.`;
                    await safeSendMessage(jid, { text: msg });
                    await randomDelay();
                }
            }
            res.end("OK");
        });
    } else if (routename === '/reset-sesion') {
        try {
            if (fs.existsSync('auth_info')) {
                fs.rmSync('auth_info', { recursive: true, force: true });
            }
            res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Sesión borrada</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><meta http-equiv="refresh" content="5;url=/"> </head><body class="bg-light"><div class="container mt-5 text-center"><div class="card shadow p-5 mx-auto" style="max-width:500px;border-radius:15px;"><h3>✅ Sesión borrada</h3><p class="mt-3">La carpeta <strong>auth_info</strong> se eliminó correctamente.</p><p>El bot mostrará un nuevo código QR en <strong>5 segundos</strong>.</p><a href="/" class="btn btn-primary mt-3">Ir al inicio</a></div></div></body></html>`);
        } catch (e) { res.end("Error al borrar sesión: " + e.message); }
    } else if (routename === '/notificador-estado') {
        
        if (query.action === 'force_cobranza') {
            if (isBotReady()) {
                checkVendedoresRecordatorio(true).catch(e => console.log(e));
            }
            res.writeHead(302, { 'Location': '/notificador-estado' });
            return res.end();
        }

        if (query.action === 'force_stats') {
            if (isBotReady()) {
                // DESTRABAR MANUALMENTE LA VARIABLE PARA QUE ENTRE SÍ O SÍ
                estadisticasEjecutando = false; 
                checkEstadisticasVendedores(true).catch(e => console.log(e));
            }
            res.writeHead(302, { 'Location': '/notificador-estado' });
            return res.end();
        }

        const total = await notificador.obtenerFacturasNoNotificadasCount();

        res.end(`<!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
            <title>Notificador</title>
        </head>
        <body class="bg-light">
            ${header}
            <div class="container mt-5">
                <div class="card shadow-lg p-4 mx-auto" style="max-width: 600px; border-radius: 15px;">
                    <h3>📬 Notificador</h3>
                    <hr>
                    <p>Facturas pendientes por notificar a clientes: <strong>${total}</strong></p>
                    <p>Estado del Bot: ${isBotReady() ? '<span class="text-success">🟢 Online</span>' : '<span class="text-danger">🔴 Offline</span>'}</p>
                    <hr>
                    <h5>📊 Control Manual de Vendedores</h5>
                    <p class="text-muted small">Selecciona la notificación que deseas enviar en este momento (Saltará restricciones de fecha).</p>
                    <div class="d-grid gap-2 mt-3">
                        <a href="/notificador-estado?action=force_cobranza" class="btn btn-warning text-dark">⚠️ Forzar Notificación de Cuentas por Cobrar</a>
                        <a href="/notificador-estado?action=force_stats" class="btn btn-primary">📊 Forzar Envío de Estadísticas de Ventas</a>
                        <a href="/" class="btn btn-outline-secondary mt-2">Volver al Menú Principal</a>
                    </div>
                </div>
            </div>
        </body>
        </html>`);
    } else if (routename === '/historial') {
        const [msgs] = await pool.execute("SELECT h.id, h.telefono, h.rol, h.contenido, h.fecha FROM historial_chat h ORDER BY h.fecha DESC LIMIT 200");
        const rows = msgs.map(m => `<tr><td>${m.telefono}</td><td class="${m.rol === 'user' ? 'text-primary' : 'text-success'}">${m.rol}</td><td style="max-width:400px;word-break:break-word">${m.contenido}</td><td>${new Date(m.fecha).toLocaleString()}</td></tr>`).join('');
        res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><title>Historial Chat</title></head><body class="bg-light">${header}<div class="container mt-3"><h3>💬 Historial de Conversaciones</h3><div class="table-responsive"><table class="table table-sm table-striped"><thead><tr><th>Teléfono</th><th>Rol</th><th>Mensaje</th><th>Fecha</th></tr></thead><tbody>${rows}</tbody></table></div><a href="/" class="btn btn-outline-secondary">Volver</a></div></body></html>`);
    } else if (routename === '/recordatorio-estado') {
        const facturas = await notificador.obtenerFacturasVencidas();
        const enviados = await notificador.obtenerRecordatoriosEnviados();
        res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><title>Recordatorios</title></head><body class="bg-light">${header}<div class="container mt-5"><div class="card shadow-lg p-4 mx-auto" style="max-width: 800px; border-radius: 15px;"><h3>📅 Recordatorios</h3><hr><table class="table table-sm"><thead><tr><th>Factura</th><th>Cliente</th><th>Días</th><th>Estado</th></tr></thead><tbody>${facturas.map(f => `<tr><td>${f.nro_factura}</td><td>${f.nombres}</td><td>${f.dias_vencida}</td><td>${(enviados[f.id_factura]) ? '✅' : '⏳'}</td></tr>`).join('')}</tbody></table><a href="/" class="btn btn-outline-secondary">Volver</a></div></div></body></html>`);
    } else {
        res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><meta http-equiv="refresh" content="30"><title>Admin ONE4CARS</title></head><body style="background-color: #f4f7f6;">${header}<div class="container text-center"><div class="card shadow-lg p-4 mx-auto" style="max-width: 500px; border-radius: 15px;"><h4 class="mb-3">Estado del Bot</h4><div class="my-4">${qrCodeData.startsWith('data') ? `<img src="${qrCodeData}" class="img-fluid rounded" style="max-width: 250px;">` : `<h2 class="text-success">${qrCodeData}</h2>`}</div><p>BCV: ${dolarInfo.bcv} | Paralelo: ${dolarInfo.paralelo}</p><div class="d-grid gap-2"><a href="/cobranza" class="btn btn-primary">PANEL DE COBRANZA</a><a href="/marketing-panel" class="btn btn-info text-white">PANEL DE MARKETING</a><a href="/notificador-estado" class="btn btn-secondary text-white">NOTIFICADOR</a><a href="/historial" class="btn btn-info text-white">HISTORIAL</a><a href="/recordatorio-estado" class="btn btn-warning text-dark">RECORDATORIOS</a></div></div></div></body></html>`);
    }
});

server.listen(PORT, '0.0.0.0', async () => {
    await initDB();
    startBot();
    actualizarDolar();
    setInterval(actualizarDolar, 3600000);
});
