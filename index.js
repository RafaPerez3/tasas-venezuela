require('dotenv').config(); // Carga TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID desde .env en local

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const https = require('https');
const path = require('path'); // Necesario para que encuentre tu HTML en la nube

const app = express();
app.use(cors());

// --- AVISO POR TELEGRAM ---
// Manda un mensaje a tu Telegram cada vez que alguien abre la página.
// El token y el chat_id se leen de variables de entorno: nunca deben quedar
// escritos en este archivo porque el repo es público en GitHub.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function notificarTelegram(mensaje) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log('[Telegram] Falta TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID, no se envía aviso.');
        return;
    }
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: mensaje
        });
    } catch (error) {
        console.error('[Telegram] Error al enviar el aviso:', error.message);
    }
}

// --- UBICACIÓN APROXIMADA POR IP ---
// Usa un servicio gratuito de geolocalización (ciudad/región/país, no exacta).
// Las IPs privadas (de la propia red de Render, o pruebas locales) no se pueden geolocalizar.
function esIpPrivada(ip) {
    return !ip || ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('127.') || ip === '::1';
}

async function obtenerUbicacion(ip) {
    if (esIpPrivada(ip)) return null;
    try {
        const { data } = await axios.get(`https://freeipapi.com/api/json/${ip}`, { timeout: 5000 });
        const partes = [data.cityName, data.regionName, data.countryName].filter(Boolean);
        return partes.length ? partes.join(', ') : null;
    } catch (error) {
        console.error('[Ubicación] No se pudo geolocalizar la IP:', error.message);
        return null;
    }
}

// --- AGENTE PARA EL BCV ---
// Evita que el servidor se queje por los certificados de seguridad del banco
const agent = new https.Agent({ rejectUnauthorized: false });

// --- FUNCIÓN 1: BINANCE P2P ---
async function getBinanceRate() {
    try {
        const response = await axios.post(
            'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
            {
                asset: "USDT",
                fiat: "VES",
                tradeType: "SELL", // Buscamos ofertas de venta (precio de compra para el usuario)
                page: 1,
                rows: 10, 
                payTypes: ["PagoMovil"] // Filtramos por lo más común
            },
            { headers: { "User-Agent": "Mozilla/5.0" } }
        );

        const data = response.data.data;
        if (!data || data.length === 0) return "0.00";

        // Calculamos promedio
        const prices = data.map(item => parseFloat(item.adv.price));
        const average = prices.reduce((a, b) => a + b, 0) / prices.length;
        
        return average.toFixed(2); // Retornamos solo 2 decimales
    } catch (error) {
        console.error("Error Binance:", error.message);
        return "0.00";
    }
}

// --- FUNCIÓN 2: BCV (SCRAPING) ---
async function getBCVRates() {
    try {
        const { data } = await axios.get('https://www.bcv.org.ve/', { httpsAgent: agent });
        const $ = cheerio.load(data);

        // Extraemos el texto y cambiamos coma por punto
        let usdText = $('#dolar strong').text().trim().replace(',', '.');
        let eurText = $('#euro strong').text().trim().replace(',', '.');

        // Convertimos a número y fijamos 2 decimales
        let usdFinal = parseFloat(usdText).toFixed(2);
        let eurFinal = parseFloat(eurText).toFixed(2);

        return { 
            usd: isNaN(usdFinal) ? "0.00" : usdFinal, 
            eur: isNaN(eurFinal) ? "0.00" : eurFinal 
        };
    } catch (error) {
        console.error("Error BCV:", error.message);
        return { usd: "0.00", eur: "0.00" };
    }
}

// --- RUTA API (DATOS) ---
app.get('/api/tasas', async (req, res) => {
    // Ejecutamos las dos consultas a la vez para que sea rápido
    const [binance, bcv] = await Promise.all([getBinanceRate(), getBCVRates()]);

    res.json({
        fecha: new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' }),
        bcv,
        binance
    });
});

// --- RUTA PRINCIPAL (WEB) ---
// Cuando alguien entra a la página principal, avisamos por Telegram y enviamos el HTML.
app.get('/', (req, res) => {
    // x-forwarded-for trae varias IPs separadas por coma (cliente, Cloudflare, red interna
    // de Render); la primera es la real, el resto son saltos de infraestructura.
    const ipCompleta = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const clientIp = ipCompleta.split(',')[0].trim();
    const userAgent = req.headers['user-agent'] || '';
    const fecha = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });

    // El ping de UptimeRobot (que mantiene el servidor despierto) también entra
    // por aquí cada pocos minutos: lo filtramos para no llenar el Telegram de avisos falsos.
    const esMonitor = /uptimerobot/i.test(userAgent);

    console.log(`[Visita${esMonitor ? ' - monitor' : ''}] ${fecha} - IP: ${clientIp}`);
    if (!esMonitor) {
        obtenerUbicacion(clientIp).then(ubicacion => {
            const lineaUbicacion = ubicacion ? `\n📍 ${ubicacion}` : '';
            notificarTelegram(`📡 Alguien abrió Tasas Hoy\n🕒 ${fecha}\n🌐 IP: ${clientIp}${lineaUbicacion}`);
        });
    }

    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- ARCHIVOS ESTÁTICOS ---
// Va DESPUÉS de la ruta '/' a propósito: si fuera antes, express.static
// serviría index.html automáticamente en '/' y nunca pasaría por el
// aviso de Telegram de arriba. Aquí solo queda para otros archivos sueltos.
app.use(express.static(path.join(__dirname)));

// --- ARRANCAR SERVIDOR ---
// process.env.PORT es el puerto que nos asignará la nube (Render)
// 3000 es el puerto si lo usas en tu PC local
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor listo en puerto ${PORT}`));