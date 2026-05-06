const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const http = require('http');
const url = require('url');
const pino = require('pino');
const fs = require('fs');
const mysql = require('mysql2/promise');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// MODULOS EXTERNOS
const cobranza = require('./cobranza');
const marketingModulo = require('./marketing'); 

// CONFIGURACION
const PORT = process.env.PORT || 10000;
const apiKey = process.env.GEMINI_API_KEY;

const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ 
    model: "gemini-2.5-flash", // MODELO SOLICITADO
    generationConfig: { temperature: 0.7, maxOutputTokens: 1000 }
});

const dbConfig = {
    host: 'one4cars.com',
    user: 'juant200_one4car',
    password: 'Notieneclave1*',
    database: 'juant200_venezon'
};

const PDF_URL_CATALOGO = "https://www.one4cars.com/sevencorpweb/uploads/precios/Catalogo%20-%20ONE4CARS_compressed.pdf";

// TU ID DE ADMINISTRADOR
const ADMIN_ID = "228621243408492";

// MENÚ COMPLETO RESTAURADO
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

// VARIABLES GLOBALES
let qrCodeData = "Iniciando...";
let socketBot = null;
let dolarInfo = { bcv: 'Cargando...', paralelo: 'Cargando...' };

// ===== FUNCIONES DE APOYO =====
async function db() { return await mysql.createConnection(dbConfig); }

function normalizar(texto) {
    return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
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

// --- GESTIÓN DE HISTORIAL EN BASE DE DATOS ---
async function guardarMensaje(tel, rol, contenido) {
    try {
        const conn = await db();
        await conn.execute("INSERT INTO historial_chat (telefono, rol, contenido) VALUES (?, ?, ?)", [tel, rol, contenido]);
        await conn.end();
    } catch (e) { console.log("Error guardando historial"); }
}

async function obtenerHistorial(tel) {
    try {
        const conn = await db();
        const [rows] = await conn.execute("SELECT rol, contenido FROM historial_chat WHERE telefono = ? ORDER BY fecha ASC LIMIT 10", [tel]);
        await conn.end();
        return rows.map(r => `${r.rol === 'user' ? 'Cliente' : 'Bot'}: ${r.contenido}`).join("\n");
    } catch (e) { return ""; }
}

async function setModo(tel, modo) {
    const conn = await db();
    await conn.execute("INSERT INTO control_chat (telefono, modo) VALUES (?, ?) ON DUPLICATE KEY UPDATE modo = VALUES(modo)", [tel, modo]);
    await conn.end();
}

async function buscarVendedor(jid, pushName) {
    const telLimpio = jid.split('@')[0]; 
    const conn = await db();
    const [r] = await conn.execute(
        "SELECT * FROM tab_vendedores WHERE celular_vendedor LIKE ? OR telefono_vendedor LIKE ? OR nombre LIKE ? LIMIT 1", 
        [`%${telLimpio}%`, `%${telLimpio}%`, `%${pushName}%`]
    );
    await conn.end();
    return r[0] || null;
}

// ===== BASE DE DATOS =====
async function initDB() {
    let conn;
    try {
        conn = await db();
        await conn.execute(`CREATE TABLE IF NOT EXISTS control_chat (
            telefono VARCHAR(100) PRIMARY KEY, 
            usuario VARCHAR(50), 
            id_cliente_int INT,
            modo VARCHAR(20) DEFAULT 'bot', 
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);
        
        await conn.execute(`CREATE TABLE IF NOT EXISTS historial_chat (
            id INT AUTO_INCREMENT PRIMARY KEY, 
            telefono VARCHAR(100), 
            rol ENUM('user', 'model'), 
            contenido TEXT, 
            fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);
        
        console.log("✅ Base de Datos vinculada.");
    } catch (e) { console.log("❌ Error DB Init:", e.message); }
    finally { if(conn) await conn.end(); }
}

async function getSesion(jid) {
    try {
        const conn = await db();
        const [r] = await conn.execute("SELECT * FROM control_chat WHERE telefono=?", [jid]);
        await conn.end();
        return r[0] || null;
    } catch (e) { return null; }
}

async function guardarUsuario(jid, usuario, id_int) {
    const conn = await db();
    await conn.execute(`
        INSERT INTO control_chat (telefono, usuario, id_cliente_int, modo) 
        VALUES (?, ?, ?, 'bot') 
        ON DUPLICATE KEY UPDATE usuario=VALUES(usuario), id_cliente_int=VALUES(id_cliente_int), modo='bot'
    `, [jid, usuario, id_int]);
    await conn.end();
}

async function buscarCliente(rifLimpio) {
    const conn = await db();
    const [r] = await conn.execute("SELECT id_cliente, nombres, celular, cedula, direccion, zona FROM tab_clientes WHERE clave = ? OR clave LIKE ? LIMIT 1", [rifLimpio, `%${rifLimpio}%`]);
    await conn.end();
    return r[0] || null;
}

// NUEVA FUNCIÓN: Búsqueda en tab_productos
async function buscarProductoPorTexto(texto) {
    const palabras = normalizar(texto).split(' ').filter(p => p.length > 2);
    if (palabras.length === 0) return null;

    const conn = await db();
    let query = "SELECT producto, descripcion, tipo FROM tab_productos WHERE ";
    let conditions = palabras.map(() => "descripcion LIKE ?").join(" AND ");
    let params = palabras.map(p => `%${p}%`);

    try {
        const [rows] = await conn.execute(query + conditions + " LIMIT 5", params);
        await conn.end();
        return rows.length > 0 ? rows : null;
    } catch (e) {
        if(conn) await conn.end();
        return null;
    }
}

async function obtenerDetalleFacturas(id_cliente, id_vendedor = null) {
    const conn = await db();
    let query = `
        SELECT f.id_factura, f.nro_factura, f.total, f.abono_factura, f.fecha_reg, f.porcentaje, f.descuento, f.total_desc,
                c.nombres, c.direccion, c.cedula, c.celular, c.telefono, c.id_cliente, c.zona, c.vendedor as nombre_vendedor
         FROM tab_facturas f
         JOIN tab_clientes c ON f.id_cliente = c.id_cliente
         WHERE f.id_cliente = ? AND f.pagada = 'NO' AND f.anulado = 'no'`;
    let params = [id_cliente];
    if (id_vendedor) { query += ` AND f.id_vendedor = ?`; params.push(id_vendedor); }
    const [facturas] = await conn.execute(query, params);
    await conn.end();
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

        // 🚫 1. FILTRO DE GRUPOS
        if (from === 'status@broadcast' || from.includes('@g.us')) return;

        const isAdmin = from.includes(ADMIN_ID);
        const vendedor = await buscarVendedor(from, msg.pushName || "Vendedor");

        // 👤 2. DETECTAR SI EL HUMANO RESPONDE (DESACTIVAR BOT)
        if (msg.key.fromMe) {
            const textMe = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase();
            if (textMe === '!bot') {
                await setModo(from, 'bot');
                await sock.sendMessage(from, { text: "🤖 IA Reactivada para este chat." });
            } else if (!isAdmin) {
                await setModo(from, 'humano');
            }
            return;
        }

        const pushName = msg.pushName || "Usuario";
        const rawText = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        if (!rawText) return;

        const text = normalizar(rawText);
        const rifDetectado = rawText.replace(/\D/g, '');

        // GUARDAR EN HISTORIAL
        await guardarMensaje(from, 'user', rawText);

        // VERIFICAR MODO DEL CHAT
        const sesion = await getSesion(from);
        if (sesion && sesion.modo === 'humano' && !isAdmin) return;

        // ⭐ 3. LÓGICA DE ADMINISTRADOR MAESTRO (EL JEFE)
        if (isAdmin) {
            const fechaHora = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });
            const saludoJefe = `⭐ *HOLA JEFE / ADMINISTRADOR*\n\nBienvenido de nuevo. Hoy es ${fechaHora}.\n\n*Tasas:* BCV: ${dolarInfo.bcv} | Paralelo: ${dolarInfo.paralelo}\n\nUsted tiene acceso total. Puede enviar cualquier RIF para consultar el estado de cuenta de un cliente o escribir *menu* para ver las opciones del sistema.`;

            if (text === 'dolar') {
                await actualizarDolar();
                const dMsg = `💵 BCV: ${dolarInfo.bcv}\n📈 Paralelo: ${dolarInfo.paralelo}`;
                return await sock.sendMessage(from, { text: dMsg });
            }
            if (text === 'menu' || text === 'hola' || text === 'buen dia') {
                return await sock.sendMessage(from, { text: saludoJefe });
            }

            // Consulta RIF Master corregida (Eliminada opción VER)
            if (rifDetectado.length >= 6 && /^\d+$/.test(rawText.replace(/\s/g, ''))) {
                const c = await buscarCliente(rifDetectado);
                if (c) {
                    const facturas = await obtenerDetalleFacturas(c.id_cliente);
                    let totalP = 0; 
                    let list = `⭐ *CONSULTA MASTER*\nCliente: ${c.nombres}\n\n`;
                    
                    if (facturas.length === 0) {
                        list += `✅ El cliente no tiene facturas pendientes.`;
                    } else {
                        facturas.forEach(f => {
                            const monto = (f.total - f.abono_factura) / (f.porcentaje || 1);
                            totalP += monto;
                            list += `🔸 *#${f.nro_factura}* | $${monto.toFixed(2)}\n✍️ Firmada: https://www.one4cars.com/uploads/notas/${f.nro_factura}.jpg\n\n`;
                        });
                        list += `💰 *Total Máster: $${totalP.toFixed(2)}*`;
                    }
                    return await sock.sendMessage(from, { text: list });
                } else {
                    return await sock.sendMessage(from, { text: "❌ No se encontró ningún cliente con ese RIF/Cédula." });
                }
            }
        }

        // VENDEDOR
        if (vendedor && (text === 'menu' || text === 'hola')) {
            return await sock.sendMessage(from, { text: `👋 Hola Vendedor(a) *${vendedor.nombre}*.\n\n${MENU_TEXT}` });
        }

        // CLIENTE VINCULAR
        if (rifDetectado.length >= 6 && (!sesion || !sesion.id_cliente_int || text.includes('rif')) && !isAdmin) {
            const c = await buscarCliente(rifDetectado);
            if (c) {
                await guardarUsuario(from, rifDetectado, c.id_cliente);
                return await sock.sendMessage(from, { text: `✅ ¡Hola *${c.nombres}*! RIF vinculado.\n\n${MENU_TEXT}` });
            }
        }

        if (text === 'menu') return await sock.sendMessage(from, { text: MENU_TEXT });
        
        if (text.includes("saldo") || text === '2') {
            const targetID = sesion?.id_cliente_int;
            if (!targetID) return await sock.sendMessage(from, { text: "Por favor envíe su RIF para identificarse." });
            const facturas = await obtenerDetalleFacturas(targetID);
            if (facturas.length === 0) return await sock.sendMessage(from, { text: "✅ No posee facturas pendientes." });
            let totalP = 0; let listado = "*📄 FACTURAS PENDIENTES:*\n\n";
            facturas.forEach(f => {
                const monto = (f.total - f.abono_factura) / (f.porcentaje || 1);
                totalP += monto;
                const fReg = new Date(f.fecha_reg).toISOString().split('T')[0];
                const params = `id_factura=${f.id_factura}&nro_factura=${f.nro_factura}&fecha_reg=${fReg}&total=${f.total}&abono_factura=${f.abono_factura}&nombres=${encodeURIComponent(f.nombres.trim())}&nombre=${encodeURIComponent(f.nombre_vendedor.trim())}&direccion=${encodeURIComponent(f.direccion.trim())}&cedula=${f.cedula.trim()}&celular=${encodeURIComponent(f.celular.trim())}&telefono=${encodeURIComponent(f.telefono.trim())}&id_cliente=${f.id_cliente}&zona=${encodeURIComponent(f.zona.trim())}&descuento=${f.descuento}&total_desc=${f.total_desc}`;
                listado += `🔸 *#${f.nro_factura}* | $${monto.toFixed(2)}\n📄 PDF: https://one4cars.com/sevencorp/factura_full_reporte_web.php?${params}\n\n`;
            });
            listado += `💰 *TOTAL A PAGAR: $${totalP.toFixed(2)}*`;
            return await sock.sendMessage(from, { text: listado });
        }

        // 🤖 4. IA GEMINI CON BÚSQUEDA DE PRODUCTOS INTEGRADA
        try {
            const inst = fs.readFileSync('./instrucciones.txt', 'utf8');
            const historial = await obtenerHistorial(from);
            
            // Inyectar búsqueda de productos en el contexto de la IA
            let contextoProductos = "";
            if (text.length > 4 && !isAdmin && !text.includes("saldo")) {
                const prods = await buscarProductoPorTexto(rawText);
                if (prods) {
                    contextoProductos = "\n\nPRODUCTOS ENCONTRADOS EN NUESTRA BASE DE DATOS:\n";
                    prods.forEach(p => {
                        contextoProductos += `- Código: ${p.producto} | Tipo: ${p.tipo} | Descripción: ${p.descripcion}\n`;
                        contextoProductos += `- Ficha técnica: https://one4cars.com/producto_general.php?cod=${p.producto}&tipo=${encodeURIComponent(p.tipo)}\n`;
                    });
                    contextoProductos += "\nUsa esta información técnica para responder al cliente. Si el cliente pregunta medidas, están en la descripción. Menciona siempre el link de la ficha técnica.";
                }
            }

            const prompt = `INSTRUCCIONES:\n${inst}\n\nCONTEXTO:\nDólar BCV: ${dolarInfo.bcv} | Paralelo: ${dolarInfo.paralelo}\nUsuario: ${pushName}${contextoProductos}\n\nHISTORIAL:\n${historial}\n\nMENSAJE: ${rawText}`;
            
            const result = await model.generateContent(prompt);
            const rIA = result.response.text();
            await guardarMensaje(from, 'model', rIA);
            await sock.sendMessage(from, { text: rIA });
        } catch (e) { console.log("IA Error"); }
    });
}

// ===== SERVIDOR HTTP COMPLETO RESTAURADO =====
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
        const conn = await db();
        let sql = "SELECT id_cliente, nombres, celular FROM tab_clientes WHERE celular IS NOT NULL AND celular != ''";
        const params = [];
        if (parsedUrl.query.vendedor) { sql += " AND vendedor = ?"; params.push(parsedUrl.query.vendedor); }
        if (parsedUrl.query.zona) { sql += " AND zona = ?"; params.push(parsedUrl.query.zona); }
        const [clientes] = await conn.execute(sql, params);
        await conn.end();
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(clientes));

    } else if (parsedUrl.pathname === '/enviar-marketing' && req.method === 'POST') {
        if (!isBotReady()) return res.end("⚠️ Bot no listo.");
        let b = ''; req.on('data', c => b += c);
        req.on('end', async () => {
            const data = JSON.parse(b);
            for (const id of data.clientes) {
                const conn = await db();
                const [rows] = await conn.execute("SELECT * FROM tab_clientes WHERE id_cliente=?", [id]);
                await conn.end();
                if (rows[0]) {
                    const c = rows[0];
                    const jid = formatWhatsApp(c.celular);
                    try {
                        if (data.tipo === 'precios') {
                            await socketBot.sendMessage(jid, { document: { url: PDF_URL_CATALOGO }, fileName: 'Catalogo-ONE4CARS.pdf', mimetype: 'application/pdf', caption: `¡Hola *${c.nombres}*! Aquí tienes nuestro catálogo actualizado. 🚀` });
                        } else if (data.tipo === 'promo') {
                            let msg = data.subtipo === 'bienvenida' ? `*🛠️ ¡Tu Negocio, al Máximo Nivel con ONE4CARS!*\n\n¡Hola *${c.nombres}*! 👋\n\nRecibe un cordial saludo de la gerencia de ventas de *ONE4CARS*.\n\n*🌐 Acceso a tu Portal Mayorista:*\n*Enlace:* https://one4cars.com/mayoristas\n*LOGIN:* ${c.usuario}\n*PASSWORD:* ${c.clave}\n\n*🚀 Tu página personalizada:*\n➡️ https://www.one4cars.com/${c.usuario}` : (data.subtipo === 'satisfaccion' ? `*📊 CONSULTA DE SATISFACCIÓN - ONE4CARS*\n\n¡Hola *${c.nombres}*! 👋\n\n¿Cómo ha sido tu experiencia con la calidad de nuestros productos?` : data.mensaje);
                            await socketBot.sendMessage(jid, { text: msg });
                        }
                        await randomDelay();
                    } catch (e) { console.log("Error enviando marketing"); }
                }
            }
            res.end("OK");
        });

    } else if (parsedUrl.pathname === '/enviar-cobranza' && req.method === 'POST') {
        if (!isBotReady()) return res.end("⚠️ Bot no listo.");
        let b = ''; req.on('data', c => b += c);
        req.on('end', async () => {
            const data = JSON.parse(b);
            for (const id_cliente of data.facturas) {
                const conn = await db();
                const [facturas] = await conn.execute(
                    "SELECT f.nro_factura, f.total, f.abono_factura, f.fecha_reg, f.porcentaje, c.nombres, c.celular FROM tab_facturas f JOIN tab_clientes c ON f.id_cliente = c.id_cliente WHERE f.id_cliente = ? AND f.pagada = 'NO' AND f.anulado = 'no'", 
                    [id_cliente]
                );
                await conn.end();
                for (const f of facturas) {
                    const jid = formatWhatsApp(f.celular);
                    const hoy = new Date();
                    const fReg = new Date(f.fecha_reg);
                    const diffDays = Math.ceil(Math.abs(hoy - fReg) / (1000 * 60 * 60 * 24));
                    const vencimiento = diffDays > 30 ? diffDays - 30 : 0;
                    const saldoBs = (f.total - f.abono_factura) / (f.porcentaje || 1);
                    const msg = `Hola *${f.nombres}* 🚗, le recordamos su factura #${f.nro_factura} pendiente.\nSaldo: Bs. *${saldoBs.toLocaleString('es-VE')}*\nDías vencidos: ${vencimiento}.\nPor favor gestione su pago.`;
                    await socketBot.sendMessage(jid, { text: msg });
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
