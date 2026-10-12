require('dotenv').config(); // Carga TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID desde .env en local

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
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

        // "Fecha Valor": el día para el que rige esta tasa (el BCV la publica el día antes).
        // Es la fecha con la que se guarda en el historial.
        let fecha = null;
        $('.date-display-single').each((_, el) => {
            if (/fecha valor/i.test($(el).parent().text())) {
                const candidata = ($(el).attr('content') || '').slice(0, 10);
                if (/^\d{4}-\d{2}-\d{2}$/.test(candidata)) fecha = candidata;
                return false; // ya la encontramos, dejamos de buscar
            }
        });

        return {
            usd: isNaN(usdFinal) ? "0.00" : usdFinal,
            eur: isNaN(eurFinal) ? "0.00" : eurFinal,
            fecha
        };
    } catch (error) {
        console.error("Error BCV:", error.message);
        return { usd: "0.00", eur: "0.00", fecha: null };
    }
}

// --- ESTADO (para saber cuánto subió o bajó) ---
// Guardamos el último valor "confirmado" de cada tasa y el que tenía justo antes,
// para poder mostrar la variación. Se guarda en un archivo local, y si hay base de
// datos (Upstash) se reconstruye desde ahí cuando Render reinicia el servicio.
const RUTA_HISTORIAL = path.join(__dirname, 'historial.json');

let historial = {
    bcv: { usd: null, eur: null, fecha: null },   // último valor BCV visto y su "fecha valor"
    bcvAnterior: { usd: null, eur: null },        // el que tenía antes de cambiar (se actualiza 1 vez al día)
    binance: { valor: null, hora: null, fecha: null },          // valor de USDT de la hora en curso
    binanceAnterior: { valor: null, hora: null, fecha: null }   // valor de la hora anterior
};

function cargarHistorial() {
    try {
        if (fs.existsSync(RUTA_HISTORIAL)) {
            historial = { ...historial, ...JSON.parse(fs.readFileSync(RUTA_HISTORIAL, 'utf8')) };
            console.log('[Historial] Cargado desde disco.');
        }
    } catch (error) {
        console.error('[Historial] No se pudo leer, se empieza de cero:', error.message);
    }
}

function guardarHistorial() {
    try {
        fs.writeFileSync(RUTA_HISTORIAL, JSON.stringify(historial, null, 2));
    } catch (error) {
        console.error('[Historial] No se pudo guardar:', error.message);
    }
}

function horaActualCaracas() {
    // Devuelve 0-23 en hora de Venezuela, sin depender de en qué zona horaria esté Render.
    // hourCycle h23 evita que la medianoche salga como "24".
    return parseInt(
        new Date().toLocaleString('en-US', { timeZone: 'America/Caracas', hour: '2-digit', hourCycle: 'h23' }),
        10
    );
}

// Fecha de Venezuela como "YYYY-MM-DD" (haceDias = 0 es hoy, 1 es ayer, ...)
function fechaCaracas(haceDias = 0) {
    const dia = new Date(Date.now() - haceDias * 24 * 60 * 60 * 1000);
    const partes = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(dia);
    const valor = tipo => partes.find(p => p.type === tipo).value;
    return `${valor('year')}-${valor('month')}-${valor('day')}`;
}

// --- BASE DE DATOS (Upstash Redis, por REST) ---
// Aquí vive el historial de días anteriores, porque el disco de Render se borra
// cada vez que el servicio se reinicia. Datos:
//   hash "bcv"           -> campo: fecha valor (YYYY-MM-DD)  valor: {"usd":"876.80","eur":"1012.30"}
//   hash "usdt:<fecha>"  -> campo: hora (0-23)               valor: USDT de esa hora en punto
// Las variables UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN se ponen en Render.
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const REGEX_FECHA = /^\d{4}-\d{2}-\d{2}$/;

function redisActivo() {
    return Boolean(UPSTASH_URL && UPSTASH_TOKEN);
}

// Manda varios comandos juntos, p. ej. [['HSET', 'bcv', '2026-10-13', '{...}'], ['EXPIRE', ...]].
// Devuelve un arreglo con el resultado de cada uno, y lanza error si alguno falla.
async function redisPipeline(comandos) {
    const { data } = await axios.post(`${UPSTASH_URL}/pipeline`, comandos, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
        timeout: 8000
    });
    return data.map(item => {
        if (item.error) throw new Error(item.error);
        return item.result;
    });
}

// HGETALL puede llegar como arreglo plano [campo, valor, campo, valor...] o como objeto
function hashAObjeto(resultado) {
    if (!resultado) return {};
    if (Array.isArray(resultado)) {
        const objeto = {};
        for (let i = 0; i + 1 < resultado.length; i += 2) objeto[resultado[i]] = resultado[i + 1];
        return objeto;
    }
    return resultado;
}

// Convierte lo leído de Redis en algo cómodo para la página:
//   bcv:  [{ fecha, usd, eur }]  de la más reciente a la más vieja
//   usdt: [{ fecha, horas: [{ hora, valor }], min, max, promedio }]  de hoy hacia atrás
function armarHistorial(bcvHash, usdtPorFecha, limite) {
    const bcv = Object.entries(bcvHash)
        .filter(([fecha]) => REGEX_FECHA.test(fecha))
        .map(([fecha, json]) => {
            try {
                const v = JSON.parse(json);
                return { fecha, usd: Number(v.usd), eur: Number(v.eur) };
            } catch (e) {
                return null;
            }
        })
        .filter(e => e && e.usd > 0 && e.eur > 0)
        .sort((a, b) => b.fecha.localeCompare(a.fecha))
        .slice(0, limite);

    const usdt = Object.entries(usdtPorFecha)
        .map(([fecha, hash]) => {
            const horas = Object.entries(hash)
                .map(([hora, valor]) => ({ hora: Number(hora), valor: Number(valor) }))
                .filter(p => Number.isInteger(p.hora) && p.hora >= 0 && p.hora <= 23 && p.valor > 0)
                .sort((a, b) => a.hora - b.hora);
            if (horas.length === 0) return null;

            const valores = horas.map(p => p.valor);
            const promedio = valores.reduce((a, b) => a + b, 0) / valores.length;
            return {
                fecha,
                horas,
                min: Math.min(...valores),
                max: Math.max(...valores),
                promedio: Number(promedio.toFixed(2))
            };
        })
        .filter(Boolean)
        .sort((a, b) => b.fecha.localeCompare(a.fecha));

    return { bcv, usdt };
}

// Lee de Redis el BCV completo y los últimos `dias` días del USDT.
async function leerHistorial(dias) {
    const fechas = Array.from({ length: dias }, (_, i) => fechaCaracas(i));
    const comandos = [['HGETALL', 'bcv'], ...fechas.map(f => ['HGETALL', `usdt:${f}`])];
    const resultados = await redisPipeline(comandos);

    const usdtPorFecha = {};
    fechas.forEach((fecha, i) => { usdtPorFecha[fecha] = hashAObjeto(resultados[i + 1]); });
    return armarHistorial(hashAObjeto(resultados[0]), usdtPorFecha, dias);
}

// Para no repetir la misma escritura cada 5 minutos mientras el BCV no cambia
let ultimoBcvGuardado = null;

async function guardarBcvEnRedis(bcv) {
    if (!redisActivo()) return;
    if (!bcv.fecha) {
        console.log('[Redis] No se encontró la fecha valor del BCV, no se guarda en el historial.');
        return;
    }
    const firma = `${bcv.fecha}|${bcv.usd}|${bcv.eur}`;
    if (firma === ultimoBcvGuardado) return;

    try {
        await redisPipeline([['HSET', 'bcv', bcv.fecha, JSON.stringify({ usd: bcv.usd, eur: bcv.eur })]]);
        ultimoBcvGuardado = firma;
        console.log(`[Redis] BCV guardado para ${bcv.fecha}: USD ${bcv.usd} / EUR ${bcv.eur}`);
    } catch (error) {
        console.error('[Redis] No se pudo guardar el BCV:', error.message);
    }
}

async function guardarUsdtEnRedis(fecha, hora, valor) {
    if (!redisActivo()) return;
    const clave = `usdt:${fecha}`;
    try {
        // HSETNX: si ya hay una muestra de esa hora (p. ej. tras un reinicio) no la pisa
        await redisPipeline([
            ['HSETNX', clave, String(hora), String(valor)],
            ['EXPIRE', clave, String(60 * 60 * 24 * 400)] // se borran solas pasado más de un año
        ]);
        console.log(`[Redis] USDT guardado: ${fecha} ${hora}h = ${valor}`);
    } catch (error) {
        console.error('[Redis] No se pudo guardar el USDT:', error.message);
    }
}

// Al arrancar, reconstruye "valor actual" y "valor anterior" desde Redis, para que
// las variaciones sigan funcionando aunque Render haya reiniciado el servicio.
async function restaurarDesdeRedis() {
    if (!redisActivo()) return;
    try {
        const { bcv, usdt } = await leerHistorial(2);

        if (bcv[0]) {
            historial.bcv = { usd: bcv[0].usd.toFixed(2), eur: bcv[0].eur.toFixed(2), fecha: bcv[0].fecha };
            ultimoBcvGuardado = `${bcv[0].fecha}|${historial.bcv.usd}|${historial.bcv.eur}`;
        }
        if (bcv[1]) {
            historial.bcvAnterior = { usd: bcv[1].usd.toFixed(2), eur: bcv[1].eur.toFixed(2) };
        }

        const muestras = usdt
            .flatMap(dia => dia.horas.map(p => ({ fecha: dia.fecha, hora: p.hora, valor: p.valor })))
            .sort((a, b) => `${a.fecha} ${String(a.hora).padStart(2, '0')}`.localeCompare(`${b.fecha} ${String(b.hora).padStart(2, '0')}`));
        const ultima = muestras[muestras.length - 1];
        const previa = muestras[muestras.length - 2];
        if (ultima) historial.binance = { valor: ultima.valor.toFixed(2), hora: ultima.hora, fecha: ultima.fecha };
        if (previa) historial.binanceAnterior = { valor: previa.valor.toFixed(2), hora: previa.hora, fecha: previa.fecha };

        console.log('[Redis] Estado restaurado desde la base de datos.');
    } catch (error) {
        console.error('[Redis] No se pudo restaurar el estado:', error.message);
    }
}

// Se corre sola cada pocos minutos: detecta cuándo cambia el BCV (una vez al día)
// y cuándo cambia la hora (para la foto del USDT), y va rotando anterior/actual.
async function actualizarHistorial() {
    const [binanceNuevo, bcvNuevo] = await Promise.all([getBinanceRate(), getBCVRates()]);

    if (bcvNuevo.usd !== "0.00") {
        const yaHabiaValor = historial.bcv.usd !== null;
        const cambioDeValor = yaHabiaValor && historial.bcv.usd !== bcvNuevo.usd;
        if (cambioDeValor) {
            historial.bcvAnterior = { usd: historial.bcv.usd, eur: historial.bcv.eur };
        }
        historial.bcv = { usd: bcvNuevo.usd, eur: bcvNuevo.eur, fecha: bcvNuevo.fecha };
        await guardarBcvEnRedis(bcvNuevo);
    }

    if (binanceNuevo !== "0.00") {
        const horaActual = horaActualCaracas();
        const fechaActual = fechaCaracas();
        const cambioDeHora = historial.binance.hora !== horaActual || historial.binance.fecha !== fechaActual;
        if (cambioDeHora) {
            // Cambiamos de hora: lo que teníamos como "actual" pasa a ser "de la hora anterior"
            if (historial.binance.valor !== null) {
                historial.binanceAnterior = { ...historial.binance };
            }
            historial.binance = { valor: binanceNuevo, hora: horaActual, fecha: fechaActual };
            await guardarUsdtEnRedis(fechaActual, horaActual, binanceNuevo);
        } else {
            // Seguimos en la misma hora: solo refrescamos el valor "en curso"
            historial.binance.valor = binanceNuevo;
        }
    }

    guardarHistorial();
}

// Compara un valor actual contra uno anterior y devuelve la diferencia en Bs y en %.
// Devuelve null si todavía no hay con qué comparar (recién arrancó el servidor).
function calcularCambio(actual, anterior) {
    const actualNum = parseFloat(actual);
    const anteriorNum = parseFloat(anterior);
    if (!actualNum || !anteriorNum) return null;

    const diferenciaBs = actualNum - anteriorNum;
    const porcentaje = (diferenciaBs / anteriorNum) * 100;
    return { diferenciaBs: diferenciaBs.toFixed(2), porcentaje: porcentaje.toFixed(2) };
}

// La "brecha" es cuánto más caro está el USDT del P2P frente al dólar oficial del BCV.
function calcularBrecha(usd, usdt) {
    const usdNum = parseFloat(usd);
    const usdtNum = parseFloat(usdt);
    if (!usdNum || !usdtNum) return null;
    return (((usdtNum - usdNum) / usdNum) * 100).toFixed(2);
}

// --- RUTA API (DATOS) ---
app.get('/api/tasas', async (req, res) => {
    // Ejecutamos las dos consultas a la vez para que sea rápido
    const [binance, bcv] = await Promise.all([getBinanceRate(), getBCVRates()]);

    res.json({
        fecha: new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' }),
        bcv,
        binance,
        brecha: calcularBrecha(bcv.usd, binance),
        cambios: {
            usd: calcularCambio(bcv.usd, historial.bcvAnterior.usd),
            eur: calcularCambio(bcv.eur, historial.bcvAnterior.eur),
            binance: calcularCambio(binance, historial.binanceAnterior.valor)
        }
    });
});

// --- RUTA API (HISTORIAL) ---
// Se guarda la última respuesta 2 minutos para no pegarle a Redis cada vez que alguien
// abre la pestaña (el plan gratis tiene un tope mensual de comandos).
let cacheHistorial = { dias: 0, momento: 0, datos: null };

app.get('/api/historial', async (req, res) => {
    if (!redisActivo()) {
        return res.json({ disponible: false, bcv: [], usdt: [] });
    }

    const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 30, 1), 90);
    const ahora = Date.now();
    if (cacheHistorial.datos && cacheHistorial.dias === dias && ahora - cacheHistorial.momento < 2 * 60 * 1000) {
        return res.json(cacheHistorial.datos);
    }

    try {
        const datos = { disponible: true, hoy: fechaCaracas(), ...(await leerHistorial(dias)) };
        cacheHistorial = { dias, momento: ahora, datos };
        res.json(datos);
    } catch (error) {
        console.error('[Historial] No se pudo leer de Redis:', error.message);
        res.status(502).json({ disponible: false, bcv: [], usdt: [] });
    }
});

// --- RUTA API (HISTORIAL DEL BCV: BUSCAR UN DÍA / VER MÁS) ---
// El BCV completo es chico (un registro por día hábil), así que se lee entero y se
// guarda 2 minutos en memoria.
let cacheBcvCompleto = { momento: 0, entradas: [] };

async function leerBcvCompleto() {
    if (Date.now() - cacheBcvCompleto.momento < 2 * 60 * 1000) return cacheBcvCompleto.entradas;
    const [hash] = await redisPipeline([['HGETALL', 'bcv']]);
    const { bcv } = armarHistorial(hashAObjeto(hash), {}, Infinity); // de la más reciente a la más vieja
    cacheBcvCompleto = { momento: Date.now(), entradas: bcv };
    return bcv;
}

// ?fecha=YYYY-MM-DD  -> la tasa de ese día. Si el BCV no publicó una con esa fecha exacta
//                       (fin de semana, feriado) devuelve la que estaba vigente ese día.
// ?limite=N          -> las últimas N tasas publicadas.
app.get('/api/historial/bcv', async (req, res) => {
    if (!redisActivo()) return res.json({ disponible: false });

    try {
        const entradas = await leerBcvCompleto();

        if (req.query.fecha !== undefined) {
            const fecha = String(req.query.fecha);
            if (!REGEX_FECHA.test(fecha)) return res.status(400).json({ disponible: true, error: 'Fecha inválida' });
            if (entradas.length === 0) return res.json({ disponible: true, encontrado: false, primera: null });

            const exacta = entradas.find(e => e.fecha === fecha);
            if (exacta) return res.json({ disponible: true, encontrado: true, exacta: true, pedida: fecha, ...exacta });

            // Más nueva que la última tasa publicada: todavía no existe
            if (fecha > entradas[0].fecha) {
                return res.json({ disponible: true, encontrado: false, futura: true, ultima: entradas[0].fecha });
            }
            // La vigente ese día es la publicada más reciente que no sea posterior a la fecha pedida
            const vigente = entradas.find(e => e.fecha < fecha);
            if (!vigente) {
                return res.json({ disponible: true, encontrado: false, primera: entradas[entradas.length - 1].fecha });
            }
            return res.json({ disponible: true, encontrado: true, exacta: false, pedida: fecha, ...vigente });
        }

        const limite = Math.min(Math.max(parseInt(req.query.limite, 10) || 30, 1), 365);
        res.json({ disponible: true, total: entradas.length, bcv: entradas.slice(0, limite) });
    } catch (error) {
        console.error('[Historial] No se pudo leer el BCV de Redis:', error.message);
        res.status(502).json({ disponible: false });
    }
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
app.listen(PORT, async () => {
    console.log(`🚀 Servidor listo en puerto ${PORT}`);
    console.log(`[Redis] ${redisActivo() ? 'Conectado a Upstash.' : 'Sin UPSTASH_REDIS_REST_URL/TOKEN: el historial por días no estará disponible.'}`);

    // Un error aquí nunca debe tumbar el servidor, así que cada vuelta atrapa lo suyo
    const revisar = () => actualizarHistorial().catch(error => console.error('[Historial] Error al actualizar:', error.message));

    cargarHistorial();
    await restaurarDesdeRedis();
    revisar(); // primera lectura al arrancar, no esperamos 5 minutos
    setInterval(revisar, 5 * 60 * 1000); // cada 5 minutos revisa si cambió la hora o el BCV
});