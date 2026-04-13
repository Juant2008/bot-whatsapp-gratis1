const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const http = require('http');
const url = require('url');
const pino = require('pino');
const fs = require('fs');
const mysql = require('mysql2/promise');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// ===== CONFIG =====
const PORT = process.env.PORT || 10000;
const apiKey = process.env.GEMINI_API_KEY || "";

// TU ID DE ADMINISTRADOR (EL JEFE)
const ADMIN_ID = "228621243408492";

// ===== IA - ACTUALIZADO A GEMINI 2.5 FLASH =====
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ 
    model: "gemini-2.5-flash",
    generationConfig: { temperature: 0.7, maxOutputTokens: 1000 }
});

// ===== DB =====
const dbConfig = {
    host: 'one4cars.com',
    user: 'juant200_one4car',
    password: 'Notieneclave1*',
    database: 'juant200_venezon'
};

// ===== VARIABLES =====
let qrCodeData = "Iniciando...";
let sockGlobal = null;

// ===== HELPERS =====
function limpiarCedula(texto) {
    return texto.replace(/\D/g, '');
}

async function db() {
    return await mysql.createConnection(dbConfig);
}

async function getSesion(tel) {
    const conn = await db();
    const [r] = await conn.execute("SELECT * FROM control_chat WHERE telefono=?", [tel]);
    await conn.end();
    return r[0] || null;
}

async function setModo(tel, modo) {
    const conn = await db();
    await conn.execute(`
        INSERT INTO control_chat (telefono, modo)
        VALUES (?,?)
        ON DUPLICATE KEY UPDATE modo=VALUES(modo)
    `, [tel, modo]);
    await conn.end();
}

async function guardarUsuario(tel, usuario) {
    const conn = await db();
    await conn.execute(`
        INSERT INTO control_chat (telefono, usuario, modo)
        VALUES (?,?, 'bot')
        ON DUPLICATE KEY UPDATE usuario=VALUES(usuario)
    `, [tel, usuario]);
    await conn.end();
}

async function buscarCliente(usuario) {
    const conn = await db();
    const [r] = await conn.execute(
        "SELECT id_cliente, nombres FROM tab_clientes WHERE usuario=? LIMIT 1",
        [usuario]
    );
    await conn.end();
    return r[0] || null;
}

// 🔥 FIX EBENEZER: Esta función ahora permite filtrar por días de vencimiento
async function obtenerSaldo(id, diasVencidos = 0) {
    const conn = await db();
    // Agregamos DATEDIFF para que si pides facturas de >60 días, las de 24 días no se sumen.
    const [r] = await conn.execute(
        "SELECT SUM(total - abono_factura) saldo FROM tab_facturas WHERE id_cliente=? AND pagada='NO' AND anulado='no' AND DATEDIFF(CURDATE(), fecha_reg) >= ?",
        [id, diasVencidos]
    );
    await conn.end();
    return r[0].saldo || 0;
}

async function getChats() {
    const conn = await db();
    const [r] = await conn.execute("SELECT * FROM control_chat ORDER BY updated_at DESC");
    await conn.end();
    return r;
}

// ===== BOT =====
async function startBot() {

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ["ONE4CARS COBRANZA", "Chrome", "1.0.0"]
    });

    sockGlobal = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (u) => {
        const { connection, lastDisconnect, qr } = u;

        if (qr) {
            qrcode.toDataURL(qr, (_, url) => qrCodeData = url);
        }

        if (connection === 'open') {
            qrCodeData = "ONLINE ✅";
            console.log("CONECTADO");
        }

        if (connection === 'close') {
            const shouldReconnect =
                (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;

            if (shouldReconnect) setTimeout(startBot, 5000);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {

        const msg = messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        
        // 🚫 REGLA: NO RESPONDER GRUPOS
        if (from.includes('@g.us')) return;

        const tel = from.split('@')[0];
        const isAdmin = from.includes(ADMIN_ID);

        // 👤 REGLA: DETECTAR INTERVENCIÓN HUMANA
        if (msg.key.fromMe) {
            // Si el Jefe escribe, no apagamos el bot para él, pero para otros sí
            if (!isAdmin) await setModo(tel, 'humano');
            return;
        }

        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        if (!text) return;

        const sesion = await getSesion(tel);

        // 👑 REGLA: RECONOCER AL JEFE / ADMINISTRADOR
        if (isAdmin) {
            if (text.toLowerCase() === 'hola' || text.toLowerCase() === 'menu' || text.toLowerCase() === 'buen dia') {
                const ahora = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });
                return await sock.sendMessage(from, {
                    text: `⭐ *HOLA JEFE / ADMINISTRADOR*\n\nBienvenido de nuevo. Hoy es ${ahora}.\n\nUsted tiene acceso total al sistema de cobranza.`
                });
            }
        }

        if (sesion && sesion.modo === 'humano' && !isAdmin) return;

        // SALUDO
        if (!sesion) {
            await sock.sendMessage(from, {
                text: "👋 Bienvenido a ONE4CARS 🚗\n\nEnvíe su RIF o escriba *menu*"
            });
            await setModo(tel, 'bot');
            return;
        }

        // MENU
        if (text.toLowerCase().includes("menu")) {
            await sock.sendMessage(from, {
                text: "📋 MENÚ:\n1 Pagos\n2 Estado de cuenta\n3 Precios\n4 Pedidos\n6 Registro\n8 Despacho"
            });
            return;
        }

        // IDENTIFICAR CLIENTE
        if (!sesion || !sesion.usuario) {
            const cedula = limpiarCedula(text);

            if (cedula.length >= 6) {
                const cliente = await buscarCliente(cedula);

                if (cliente) {
                    await guardarUsuario(tel, cedula);

                    await sock.sendMessage(from, {
                        text: `Hola ${cliente.nombres} 👋\nEscriba *saldo* para consultar`
                    });
                    return;
                }
            }

            await sock.sendMessage(from, {
                text: "🔐 Envíe su RIF para continuar"
            });
            return;
        }

        const cliente = await buscarCliente(sesion.usuario);

        // SALDO
        if (text.toLowerCase().includes("saldo")) {
            const saldo = await obtenerSaldo(cliente.id_cliente);

            await sock.sendMessage(from, {
                text: `💰 Su saldo es: $${saldo.toFixed(2)}`
            });
            return;
        }

        // IA GEMINI 2.5 FLASH
        try {
            const instrucciones = fs.readFileSync('./instrucciones.txt', 'utf8');

            const promptIA = `Instrucciones:\n${instrucciones}\n\nUsuario dice: ${text}`;
            const result = await model.generateContent(promptIA);
            await sock.sendMessage(from, { text: result.response.text() });

        } catch {
            await sock.sendMessage(from, { text: "⚠️ Error, escriba menu." });
        }

    });
}

// ===== SERVER =====
// Usamos una condicional para evitar el error EADDRINUSE si index.js ya abrió el puerto
if (require.main === module) {
    const server = http.createServer(async (req, res) => {

        const parsed = url.parse(req.url, true);

        if (parsed.pathname === '/panel') {
            const chats = await getChats();

            res.end(`
            <h2>Panel</h2>
            ${chats.map(c => `
            <p>${c.telefono} - ${c.modo}
            <a href="/modo?tel=${c.telefono}&modo=${c.modo === 'bot' ? 'humano' : 'bot'}">Cambiar</a>
            </p>
            `).join('')}
            `);
            return;
        }

        if (parsed.pathname === '/modo') {
            await setModo(parsed.query.tel, parsed.query.modo);
            res.end("OK");
            return;
        }

        res.end(`
        <h2>ONE4CARS BOT</h2>
        ${qrCodeData.startsWith('data') ? `<img src="${qrCodeData}" width="250">` : `<h3>${qrCodeData}</h3>`}
        <br><a href="/panel">Panel</a>
        `);

    });

    server.listen(PORT, () => {
        console.log("Servidor cobranza corriendo en puerto", PORT);
        startBot();
    });
}

// Exportamos funciones para que index.js pueda usarlas sin duplicar el servidor
module.exports = { buscarCliente, obtenerSaldo, startBot };
