const mysql = require('mysql2/promise');

const dbConfig = {
    host: 'one4cars.com',
    user: 'juant200_one4car',
    password: 'Notieneclave1*',
    database: 'juant200_venezon'
};

async function obtenerFacturasNoNotificadas() {
    const conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute(
        `SELECT f.id_factura, f.nro_factura, f.nombres, f.celular, f.total, f.fecha_reg, f.id_cliente, f.id_vendedor,
                v.celular_vendedor, v.nombre as vendedor_nombre
         FROM tab_facturas f
         LEFT JOIN tab_vendedores v ON f.id_vendedor = v.id_vendedor
         WHERE f.whatsapp_notificado = 'NO' AND f.anulado = 'no'
         ORDER BY f.id_factura ASC`
    );
    await conn.end();
    return rows;
}

async function obtenerFacturasNoNotificadasCount() {
    const conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute("SELECT COUNT(*) as total FROM tab_facturas WHERE whatsapp_notificado = 'NO' AND anulado = 'no'");
    await conn.end();
    return rows[0].total;
}

module.exports = {
    obtenerFacturasNoNotificadas,
    obtenerFacturasNoNotificadasCount
};
