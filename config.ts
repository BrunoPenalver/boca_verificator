import Database from "better-sqlite3";
import path from "node:path";

const dataDir = process.env.DATA_DIR ?? __dirname;
const db = new Database(path.join(dataDir, "config.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`);

// Valores por defecto (equivalentes al antiguo config.ini).
// Solo se insertan si la clave no existe, así no pisan cambios hechos desde el panel.
const DEFAULTS: Record<string, string> = {
    IP: "http://200.73.128.21:3000",
    filaID: "e20251130adh",
    targetUrl: "https://bocasocios-gw.bocajuniors.com.ar/queueit/redirect",
    layoutVersion: "178162964444",
    proxy: "ultra.marsproxies.com:44443:mr9358u93R:MjzZvLtEEC",
    multitasking: "5",
};

const insertDefault = db.prepare(
    "INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)"
);
for (const [key, value] of Object.entries(DEFAULTS)) {
    insertDefault.run(key, value);
}

export function listConfig(): Record<string, string> {
    const rows = db
        .prepare("SELECT key, value FROM config")
        .all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function getConfig() {
    const map = listConfig();
    return {
        IP: map.IP ?? "",
        filaID: map.filaID ?? "",
        targetUrl: map.targetUrl ?? "",
        layoutVersion: parseInt(map.layoutVersion ?? "0", 10),
        proxy: map.proxy ?? "",
        multitasking: parseInt(map.multitasking ?? "5", 10),
    };
}

export function setConfig(values: Record<string, string>): void {
    const upsert = db.prepare(`
        INSERT INTO config (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    const tx = db.transaction((entries: [string, string][]) => {
        for (const [key, value] of entries) {
            upsert.run(key, String(value));
        }
    });
    tx(Object.entries(values));
}
