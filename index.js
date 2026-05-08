const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const http = require('http');
const url = require('url');
const pino = require('pino');
const fs = require('fs');
const mysql = require('mysql2/promise');
const axios = require('axios');

// MODULOS EXTERNOS
const cobranza = require('./cobranza');
const marketingModulo = require('./marketing'); 

// CONFIGURACION
const PORT = process.env.PORT || 10000;

// LISTA DE ADMINISTRADORES (Los 3 IDs autorizados)
const ADMIN_IDS = ["228621243408492", "97899534934200", "584142531553", "250370957778958"];

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

let qrCodeData = "Iniciando...";
let socketBot = null;
let dolarInfo = { bcv: 'Cargando...', paralelo: 'Cargando...' };

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
    const telLimpio = jid.split('@')[0]; 
    const [r] = await pool.execute(
        "SELECT * FROM tab_vendedores WHERE celular_vendedor LIKE ? OR telefono_vendedor LIKE ? OR nombre LIKE ? LIMIT 1", 
        [`%${telLimpio}%`, `%${telLimpio}%`, `%${pushName}%`]
    );
    return r[0] || null;
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

async function buscarProductoPorTexto(texto) {
    const txtNormal = normalizar(texto);
    const stopWords = ['tienes', 'la', 'del', 'quiere', 'saber', 'cuanto', 'mide', 'venden', 'donde', 'precio', 'tienen', 'el', 'una', 'un', 'hay', 'si', 'es', 'de', 'con', 'para', 'busco'];
    
    const palabras = txtNormal.split(' ')
        .filter(p => p.length > 2 && !stopWords.includes(p));
        
    if (palabras.length === 0) return null;

    let query = "SELECT producto, descripcion, tipo, precio_final FROM tab_productos WHERE ";
    let conditions = palabras.map(() => "descripcion LIKE ?").join(" AND ");
    let params = palabras.map(p => `%${p}%`);
    
    try {
        const [rows] = await pool.execute(query + conditions + " LIMIT 5", params);
        if (rows.length > 0) return rows;
    } catch (e) { console.log("Error SQL 1:", e); }

    if (palabras.length > 2) {
        const pFlex = palabras.slice(0, 2);
        const cFlex = pFlex.map(() => "descripcion LIKE ?").join(" AND ");
        const vFlex = pFlex.map(p => `%${p}%`);
        try {
            const [rows] = await pool.execute(query + cFlex + " LIMIT 5", vFlex);
            if (rows.length > 0) return rows;
        } catch (e) {}
    }

    try {
        const [rows] = await pool.execute("SELECT producto, descripcion, tipo, precio_final FROM tab_productos WHERE descripcion LIKE ? LIMIT 5", [`%${txtNormal}%`]);
        if (rows.length > 0) return rows;
    } catch (e) {}

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
    } catch (e) { console.log("Error Dolar API"); }
}

// ===== BOT WHATSAPP =====
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
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
        if (connection === 'open') { qrCodeData = "ONLINE ✅"; console.log("🚀 BOT MASTER ONLINE"); }
        if (connection === 'close') {
            const r = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (r) startBot();
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        if (from === 'status@broadcast' || from.includes('@g.us')) return;

        // VERIFICACIÓN DE ADMINISTRADOR (Cualquiera de los IDs en la lista)
        const isAdmin = ADMIN_IDS.some(id => from.includes(id));
        const vendedor = await buscarVendedor(from, msg.pushName || "Vendedor");

        if (msg.key.fromMe) {
            const textMe = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase();
            if (textMe === '!bot') {
                await setModo(from, 'bot');
                await safeSendMessage(from, { text: "🤖 Bot reactivado para este chat." });
            } else if (!isAdmin) {
                await setModo(from, 'humano');
            }
            return;
        }

        const pushName = msg.pushName || "Usuario";
        const rawText = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        if (!rawText) return;

        const text = normalizar(rawText);
        const esRIFPuro = /^[vjgje]?\d+$/i.test(rawText.replace(/[^a-zA-Z0-9]/g, '')) && rawText.length >= 6;

        await guardarMensaje(from, 'user', rawText);

        const sesion = await getSesion(from);
        if (sesion && sesion.modo === 'humano' && !isAdmin) return;

        // --- 1. LÓGICA DE RIF (RESTRINGIDA SOLO A ADMINS) ---
        if (isAdmin && esRIFPuro) {
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
        }

        // --- 2. LÓGICA DE PRODUCTOS (Para todos) ---
        if (text !== 'menu' && text !== 'hola') {
            try {
                const prods = await buscarProductoPorTexto(rawText);
                if (prods) {
                    let generalText = `✅ ¡Hola ${pushName}! Encontramos los siguientes productos relacionados:\n\n`;
                    
                    prods.forEach(p => {
                        const precioLimpio = parseFloat(p.precio_final || 0).toFixed(2);
                        generalText += `📦 *CÓDIGO: ${p.producto}*\n💰 *Precio Final: $${precioLimpio}*\n📝 ${p.descripcion}\n🔗 Ficha: https://one4cars.com/producto_general.php?cod=${p.producto}&tipo=${encodeURIComponent(p.tipo)}\n\n`;
                    });

                    for (let i = 0; i < prods.length; i++) {
                        const p = prods[i];
                        const imgUrl = `https://one4cars.com/imagen/${p.producto}.jpg`;
                        const precioLimpio = parseFloat(p.precio_final || 0).toFixed(2);
                        const caption = (i === 0) ? generalText : `📦 *CÓDIGO: ${p.producto}*\n💰 *Precio Final: $${precioLimpio}*`;

                        try {
                            await socketBot.sendMessage(from, { image: { url: imgUrl }, caption: caption });
                        } catch (imgErr) {
                            if (i === 0) await safeSendMessage(from, { text: generalText });
                        }
                    }
                    return;
                }
            } catch (e) { console.log("Error en flujo de productos:", e); }
        }

        // --- 3. COMANDOS DE ADMINISTRADOR ---
        if (isAdmin) {
            if (text === 'dolar') {
                await actualizarDolar();
                return await safeSendMessage(from, { text: `💵 BCV: ${dolarInfo.bcv}\n📈 Paralelo: ${dolarInfo.paralelo}` });
            }
            if (text === 'menu' || text === 'hola' || text === 'buen dia') {
                return await safeSendMessage(from, { text: `⭐ *MODO ADMINISTRADOR*\n\n${MENU_TEXT}` });
            }
        }

        // --- 4. VENDEDOR / CLIENTE ---
        if (vendedor && (text === 'menu' || text === 'hola')) {
            return await safeSendMessage(from, { text: `👋 Hola *${vendedor.nombre}*.\n\n${MENU_TEXT}` });
        }

        if (text === 'menu') return await safeSendMessage(from, { text: MENU_TEXT });
        
        if (text.includes("saldo") || text === '2') {
            const targetID = sesion?.id_cliente_int;
            if (!targetID) return await safeSendMessage(from, { text: "Por favor envíe su RIF para identificarse." });
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

        // --- 5. FALLBACK ---
        await safeSendMessage(from, { text: "No pude encontrar ese producto o comando. Por favor, verifica la descripción o escribe *menu* para ver las opciones." });
    });
}

// ===== SERVIDOR HTTP =====
const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const header = `<nav class="navbar navbar-dark bg-dark mb-4 shadow"><div class="container"><a class="navbar-brand fw-bold" href="/">ONE4CARS ADMIN</a></div></nav>`;

    if (parsedUrl.pathname === '/cobranza') {
        const v = await cobranza.obtenerVendedores();
        const z = await cobranza.obtenerZonas();
        const d = await cobranza.obtenerListaDeudores(parsedUrl.query);
        res.end(await cobranza.generarHTML(v, z, d, header, parsedUrl.query));
    } else if (parsedUrl.pathname === '/marketing-panel') {
        const v = await marketingModulo.obtenerVendedores();
        const z = await marketingModulo.obtenerZonas();
        const c = await marketingModulo.obtenerClientesMarketing(parsedUrl.query);
        res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
        res.end(await marketingModulo.generarHTMLMarketing(c, v, z, header, parsedUrl.query));
    } else if (parsedUrl.pathname === '/marketing-preview') {
        let sql = "SELECT id_cliente, nombres, celular FROM tab_clientes WHERE celular IS NOT NULL AND celular != ''";
        const params = [];
        if (parsedUrl.query.vendedor) { sql += " AND vendedor = ?"; params.push(parsedUrl.query.vendedor); }
        if (parsedUrl.query.zona) { sql += " AND zona = ?"; params.push(parsedUrl.query.zona); }
        const [clientes] = await pool.execute(sql, params);
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(clientes));
    } else if (parsedUrl.pathname === '/enviar-marketing' && req.method === 'POST') {
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
    } else if (parsedUrl.pathname === '/enviar-cobranza' && req.method === 'POST') {
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
    } else {
        res.end(`<!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
            <meta http-equiv="refresh" content="30">
            <title>Admin ONE4CARS</title>
        </head>
        <body style="background-color: #f4f7f6;">
            ${header}
            <div class="container text-center">
                <div class="card shadow-lg p-4 mx-auto" style="max-width: 500px; border-radius: 15px;">
                    <h4 class="mb-3">Estado del Bot</h4>
                    <div class="my-4">
                        ${qrCodeData.startsWith('data') ? `<img src="${qrCodeData}" class="img-fluid rounded" style="max-width: 250px;">` : `<h2 class="text-success">${qrCodeData}</h2>`}
                    </div>
                    <p>BCV: ${dolarInfo.bcv} | Paralelo: ${dolarInfo.paralelo}</p>
                    <div class="d-grid gap-2">
                        <a href="/cobranza" class="btn btn-primary">PANEL DE COBRANZA</a>
                        <a href="/marketing-panel" class="btn btn-info text-white">PANEL DE MARKETING</a>
                    </div>
                </div>
            </div>
        </body></html>`);
    }
});

server.listen(PORT, '0.0.0.0', async () => {
    await initDB();
    startBot();
    actualizarDolar();
    setInterval(actualizarDolar, 3600000);
});
