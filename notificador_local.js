--- START OF FILE notificador_local.js ---

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const mysql = require('mysql2/promise');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

// ==========================================
// CONFIGURACIÓN
// ==========================================
const dbConfig = {
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'venezon'
};

const INTERVALO_REVISION = 60000; // Revisar la DB cada 60 segundos
const DELAY_ENTRE_MENSAJES = 8000; // 8 segundos entre mensajes (Súper Seguro Anti-Ban)
const LIMITE_POR_CICLO = 10;       // Máximo 10 mensajes por ciclo para no saturar el socket
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

/**
 * FUNCIÓN DE NORMALIZACIÓN DE TELÉFONOS
 */
function formatPhone(phone) {
    if (!phone) return null;
    let clean = phone.replace(/\D/g, '');
    if (clean.length === 0) return null;

    if (clean.startsWith('580')) {
        clean = '58' + clean.substring(3);
    } else if (clean.startsWith('0')) {
        clean = '58' + clean.substring(1);
    } else if (!clean.startsWith('58')) {
        clean = '58' + clean;
    }
    return `${clean}@s.whatsapp.net`;
}

async function startNotificador() {
    console.log("\n⏳ [1/3] Iniciando sistema de notificaciones...");
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_local');
        
        const sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false, 
            browser: ["Notificador Local", "Chrome", "1.0.0"],
            connectTimeoutMs: 60000, 
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log('\n--------------------------------------------------');
                console.log('👉 ESCANEA EL SIGUIENTE CÓDIGO QR CON EL CELULAR DE LA EMPRESA:');
                qrcode.generate(qr, { small: true });
                console.log('--------------------------------------------------\n');
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error instanceof Error && lastDisconnect.error.message !== 'Logged Out');
                console.log(`⚠️ Conexión cerrada. Motivo: ${lastDisconnect?.error?.message || 'Desconocido'}`);
                
                if (shouldReconnect) {
                    console.log("🔄 Reiniciando conexión en 10 segundos...");
                    setTimeout(() => startNotificador(), 10000);
                } else {
                    console.log("❌ Sesión cerrada permanentemente. Borra la carpeta 'auth_info_local' y escanea el QR de nuevo.");
                }
            } 
            else if (connection === 'open') {
                console.log('\n***************************************************');
                console.log('🚀 ¡CONECTADO EXITOSAMENTE!');
                console.log('Sincronizando sesión... Espere 15 segundos.');
                console.log('***************************************************\n');
                
                await sleep(15000);
                
                console.log("✅ Sesión estable. Iniciando monitoreo de facturas...");
                // Ejecutar inmediatamente la primera vez
                procesarFacturas(sock);
                // Configurar el intervalo para las siguientes veces
                setInterval(() => procesarFacturas(sock), INTERVALO_REVISION);
            }
        });

        const survivalLog = setInterval(() => {
            if (!sock.user) {
                console.log("🕒 Sincronizando con WhatsApp... (Sigo vivo, no cierres la consola)");
            } else {
                clearInterval(survivalLog);
                console.log("✅ Socket listo y sincronizado.");
            }
        }, 15000);

    } catch (error) {
        console.error("❌ Error crítico en el arranque:", error);
    }
}

async function procesarFacturas(sock) {
    // MODIFICACIÓN AQUÍ: Eliminamos la validación estricta de sock.ws.readyState
    // Solo verificamos que el objeto sock y el usuario existan.
    if (!sock || !sock.user) {
        console.log("⏳ Esperando a que el usuario de WhatsApp esté disponible...");
        return;
    }

    let pool;
    try {
        pool = await mysql.createPool(dbConfig);

        console.log(`🔍 ${new Date().toLocaleTimeString()} - Revisando base de datos...`);

        // --- 1. NOTIFICACIONES INMEDIATAS ---
        const [nuevas] = await pool.execute(
            `SELECT f.id_factura, f.nro_factura, f.total, f.id_cliente, f.id_vendedor 
             FROM tab_facturas f 
             WHERE f.pagada = 'NO' AND f.whatsapp_notificado = 'NO' LIMIT ?`, 
            [LIMITE_POR_CICLO]
        );

        if (nuevas.length > 0) {
            console.log(`📩 Se encontraron ${nuevas.length} facturas nuevas para notificar.`);
            for (const f of nuevas) {
                await enviarNotificacionInmediata(sock, pool, f);
                await sleep(DELAY_ENTRE_MENSAJES); 
            }
        }

        // --- 2. NOTIFICACIONES DE MORA (30 DÍAS) ---
        const [morosas] = await pool.execute(
            `SELECT f.id_factura, f.nro_factura, f.total, f.id_cliente, f.id_vendedor 
             FROM tab_facturas f 
             WHERE f.pagada = 'NO' 
             AND f.whatsapp_mora = 'NO' 
             AND DATEDIFF(CURDATE(), f.fecha_reg) >= 30 LIMIT ?`, 
            [LIMITE_POR_CICLO]
        );

        if (morosas.length > 0) {
            console.log(`🚩 Se encontraron ${morosas.length} facturas en mora.`);
            for (const f of morosas) {
                await enviarNotificacionMora(sock, pool, f);
                await sleep(DELAY_ENTRE_MENSAJES);
            }
        }

    } catch (error) {
        console.error("❌ Error procesando facturas:", error.message);
    } finally {
        if (pool) await pool.end();
    }
}

async function enviarNotificacionInmediata(sock, pool, factura) {
    try {
        const [[cliente]] = await pool.execute("SELECT nombres, celular FROM tab_clientes WHERE id_cliente = ?", [factura.id_cliente]);
        const [[vendedor]] = await pool.execute("SELECT nombre, celular_vendedor FROM tab_vendedores WHERE id_vendedor = ?", [factura.id_vendedor]);

        if (cliente && vendedor) {
            const msgCliente = `📄 *Aviso de Facturación*\n\nHola *${cliente.nombres}*, se ha generado la factura *#${factura.nro_factura}* por un monto de *$${factura.total}*.`;
            const msgVendedor = `✅ *Nueva Venta*\n\nHola *${vendedor.nombre}*, se ha emitido la factura *#${factura.nro_factura}* al cliente *${cliente.nombres}*.`;

            const jidCliente = formatPhone(cliente.celular);
            const jidVendedor = formatPhone(vendedor.celular_vendedor);

            if (jidCliente) await sock.sendMessage(jidCliente, { text: msgCliente });
            if (jidVendedor) await sock.sendMessage(jidVendedor, { text: msgVendedor });

            await pool.execute("UPDATE tab_facturas SET whatsapp_notificado = 'SI' WHERE id_factura = ?", [factura.id_factura]);
            console.log(`[Inmediata] ✅ Enviada factura #${factura.nro_factura}`);
        }
    } catch (e) { console.error(`❌ Error enviando factura ${factura.id_factura}:`, e.message); }
}

async function enviarNotificacionMora(sock, pool, factura) {
    try {
        const [[cliente]] = await pool.execute("SELECT nombres, celular FROM tab_clientes WHERE id_cliente = ?", [factura.id_cliente]);
        const [[vendedor]] = await pool.execute("SELECT nombre, celular_vendedor FROM tab_vendedores WHERE id_vendedor = ?", [factura.id_vendedor]);

        if (cliente && vendedor) {
            const msgCliente = `⚠️ *RECORDATORIO DE PAGO*\n\nEstimado *${cliente.nombres}*, le informamos que su factura *#${factura.nro_factura}* presenta un retraso de más de 30 días. Monto: *$${factura.total}*.`;
            const msgVendedor = `🚩 *ALERTA DE MORA*\n\nHola *${vendedor.nombre}*, el cliente *${cliente.nombres}* tiene la factura *#${factura.nro_factura}* vencida.`;

            const jidCliente = formatPhone(cliente.celular);
            const jidVendedor = formatPhone(vendedor.celular_vendedor);

            if (jidCliente) await sock.sendMessage(jidCliente, { text: msgCliente });
            if (jidVendedor) await sock.sendMessage(jidVendedor, { text: msgVendedor });

            await pool.execute("UPDATE tab_facturas SET whatsapp_mora = 'SI' WHERE id_factura = ?", [factura.id_factura]);
            console.log(`[Mora] ✅ Enviada factura #${factura.nro_factura}`);
        }
    } catch (e) { console.error(`❌ Error mora factura ${factura.id_factura}:`, e.message); }
}

startNotificador();
