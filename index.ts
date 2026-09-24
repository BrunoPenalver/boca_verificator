import axios from "axios";
import { io } from "socket.io-client";
import pLimit from "p-limit";
import express from "express";
import cliProgress from "cli-progress";
import readline from "node:readline";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { getConfig, listConfig, setConfig } from "./config";

// ====================== TIPOS ======================
interface FilaData {
    ticketId: string;
    cookies: string;
    [key: string]: any;
}

interface ResultadoFila {
    ticketId: string;
    status: string;
    cookies?: string;
    lastUpdate?: number;
    error?: string;
    isRedirected?: boolean;
    link?: string;
    [key: string]: any;
}

// ====================== MAIN ======================
async function main() {
    // ====================== CONFIG (SQLite) ======================
    const startupConfig = getConfig();

    const IP = startupConfig.IP;
    const maxConcurrentStartup = startupConfig.multitasking;

    // ====================== PANEL WEB DE CONFIGURACIÓN ======================
    const app = express();
    app.use(express.json());

    app.get("/api/config", (_req, res) => {
        res.json(listConfig());
    });

    app.put("/api/config", (req, res) => {
        const allowed = ["IP", "filaID", "targetUrl", "layoutVersion", "proxy", "multitasking"];
        const values: Record<string, string> = {};
        for (const key of allowed) {
            if (req.body?.[key] !== undefined) values[key] = String(req.body[key]);
        }
        setConfig(values);
        res.json({ ok: true });
    });

    app.use(express.static(path.join(__dirname, "public")));

    const webPort = parseInt(process.env.PORT ?? "3001", 10);
    app.listen(webPort, "0.0.0.0", () => {
        console.log(`🌐 Panel de configuración: http://0.0.0.0:${webPort}`);
    });

    // ====================== INPUT ======================
    let maxConcurrent = maxConcurrentStartup;

    if (process.stdin.isTTY) {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        function ask(question: string): Promise<string> {
            return new Promise((resolve) => rl.question(question, resolve));
        }

        const multitasking = await ask(
            `Cantidad de procesos simultáneos [${maxConcurrentStartup}]: `
        );
        rl.close();

        if (multitasking.trim()) {
            maxConcurrent = parseInt(multitasking, 10) || maxConcurrentStartup;
        }
    }

    // ====================== AXIOS KEEP-ALIVE ======================
    const httpClient = axios.create({
        timeout: 8000,
        httpAgent: new http.Agent({ keepAlive: true, maxSockets: maxConcurrent }),
        httpsAgent: new https.Agent({ keepAlive: true, maxSockets: maxConcurrent }),
    });

    // ====================== FUNCION PROCESAR ======================
    async function procesar(fila: FilaData, cfg: ReturnType<typeof getConfig>): Promise<ResultadoFila> {
        const { ticketId, cookies } = fila;

        if (!ticketId || !cookies) {
            return {
                ticketId,
                status: "error",
                error: "Datos insuficientes",
            };
        }

        const payload = {
            targetUrl: cfg.targetUrl,
            customUrlParams: "",
            layoutVersion: cfg.layoutVersion,
            layoutName: "Boca Socios",
            isClientRedayToRedirect: null,
            isBeforeOrIdle: true,
        };

        const urlAPI = `https://bocajuniors.queue-it.net/spa-api/queue/bocajuniors/${cfg.filaID}/${ticketId}/status`;

        try {
            const response = await httpClient.post(urlAPI, payload, {
                headers: {
                    "Content-Type": "application/json;charset=UTF-8",
                    Accept: "application/json, text/javascript, */*; q=0.01",
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    Cookie: cookies,
                    Referer: `https://bocajuniors.queue-it.net/?c=bocajuniors&e=${cfg.filaID}&q=${ticketId}`,
                },
            });

            const ticketInfo = response.data.ticket ?? {};

            return {
                ...ticketInfo,
                ticketId,
                cookies,
                status: "verified",
                isRedirected: false,
                lastUpdate: Date.now(),
                link: `https://bocajuniors.queue-it.net/?c=bocajuniors&e=${cfg.filaID}&q=${ticketId}`,
            };
        } catch (err: any) {
            return {
                ticketId,
                status: "error",
                error: err?.message ?? "Error desconocido",
            };
        }
    }

    // ====================== SOCKET.IO ======================
    const socket = io(IP, { transports: ["websocket"] });

    socket.on("connect", () => {
        console.log(`\n✅ Conectado al servidor ${IP}\n`);
        socket.emit("generate_login_verificator");
    });

    socket.on("disconnect", () => {
        console.log("🔌 Cliente desconectado");
    });

    // ====================== SYNC FILAS ======================
    socket.on("sync_filas", async (filas: FilaData[]) => {
        if (!filas || filas.length === 0) {
            console.log("📭 No hay filas para verificar");
            return;
        }

        console.log(`🔄 Verificando ${filas.length} filas...\n`);

        // Lee la config fresca de SQLite en cada lote (los cambios del panel se aplican sin reiniciar)
        const cfg = getConfig();

        const total = filas.length;
        let completed = 0;

        const bar = new cliProgress.SingleBar(
            {
                format:
                    "Progreso |{bar}| {percentage}% | {value}/{total} | Tiempo: {duration_formatted}",
                hideCursor: true,
            },
            cliProgress.Presets.shades_classic
        );

        bar.start(total, 0);

        const limit = pLimit(maxConcurrent);

        const tareas = filas.map((fila) =>
            limit(async () => {
                const resultado = await procesar(fila, cfg);

                try {
                    await httpClient.put(`${IP}/api/filas/${resultado.ticketId}`, resultado);
                } catch (e: any) {
                    console.log(`❌ Error enviando ${resultado.ticketId}: ${e.message}`);
                }

                completed++;
                bar.update(completed);

                return resultado;
            })
        );

        const resultados = await Promise.all(tareas);

        bar.update(total);
        bar.stop();

        console.log("\n✅ Todos los tickets fueron verificados.\n");

        // ====================== ESTADÍSTICAS PRINCIPALES ======================
        let ok = 0;
        let queueFails = 0;
        let otherFails = 0;

        for (const r of resultados) {
            if (r.status === "verified") {
                ok++;
            } else if (String(r.error ?? "").toLowerCase().includes("queue")) {
                queueFails++;
            } else {
                otherFails++;
            }
        }

        console.log("\n📊 Estadísticas de verificación:");
        console.log(`   ✔️ Respuestas correctas (200): ${ok}`);
        console.log(`   ❌ Errores relacionados con queue: ${queueFails}`);
        console.log(`   ⚠️ Otros errores: ${otherFails}\n`);

        // ====================== ERRORES DETALLADOS ======================
        const errorMap: Record<string, number> = {};

        for (const r of resultados) {
            if (r.status !== "error") continue;

            const msg = (r.error ?? "unknown").split(":")[0]; // simplifica mensajes
            errorMap[msg] = (errorMap[msg] || 0) + 1;
        }

        console.log("📌 Tipos de errores detectados:");
        for (const [msg, count] of Object.entries(errorMap)) {
            console.log(`   - ${msg}: ${count}`);
        }

        console.log("");

        socket.emit("filas_sincronizadas", resultados);
    });

    // ====================== CTRL + C ======================
    process.on("SIGINT", () => {
        console.log("\n🔌 Cerrando...");
        socket.disconnect();
        process.exit(0);
    });
}

// Ejecutar main()
main();
