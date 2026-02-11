const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const os = require('os');
const xlsx = require('xlsx'); 

const isPkg = typeof process.pkg !== 'undefined';
let dbPath;
let dbFolder;

if (isPkg) {
    const userHome = os.homedir();
    if (process.platform === 'win32') {
        dbFolder = path.join(process.env.APPDATA || path.join(userHome, 'AppData', 'Roaming'), 'SeguimientoProyectos');
    } else {
        dbFolder = path.join(userHome, '.SeguimientoProyectos');
    }
    if (!fs.existsSync(dbFolder)) {
        fs.mkdirSync(dbFolder, { recursive: true });
    }
    dbPath = path.join(dbFolder, 'proyectos_huila.db');
    console.log("🚀 MODO PRODUCCIÓN DETECTADO. Base de datos en:", dbPath);
} else {
    dbFolder = __dirname;
    dbPath = path.join(dbFolder, 'proyectos_huila.db');
    console.log("🛠️ MODO DESARROLLO. Base de datos local en:", dbPath);
}

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('❌ Error conectando BD:', err.message);
    else console.log('✅ Conexión exitosa a SQLite.');
});

db.serialize(() => {
    // 1. Proyectos
    db.run(`CREATE TABLE IF NOT EXISTS proyectos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        codigo_bpin TEXT UNIQUE,
        nombre_proyecto TEXT UNIQUE NOT NULL,
        anio_contrato INTEGER NOT NULL,
        contratista TEXT,
        valor_inicial REAL DEFAULT 0,
        valor_rp REAL DEFAULT 0, valor_sgp REAL DEFAULT 0, valor_men REAL DEFAULT 0, valor_sgr REAL DEFAULT 0,
        fuente_recursos TEXT,
        sync_uid TEXT UNIQUE
    )`);

    // 2. Municipios
    db.run(`CREATE TABLE IF NOT EXISTS municipios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT UNIQUE NOT NULL
    )`);

    // 3. Instituciones
    db.run(`CREATE TABLE IF NOT EXISTS instituciones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        municipio_id INTEGER,
        FOREIGN KEY(municipio_id) REFERENCES municipios(id),
        UNIQUE(nombre, municipio_id)
    )`);

    // 4. Sedes
    db.run(`CREATE TABLE IF NOT EXISTS sedes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        institucion_id INTEGER,
        FOREIGN KEY(institucion_id) REFERENCES instituciones(id),
        UNIQUE(nombre, institucion_id)
    )`);

    // 4.5 Metadatos
    db.run(`CREATE TABLE IF NOT EXISTS sync_metadata (key TEXT PRIMARY KEY, value TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)`);
    db.run(`INSERT OR IGNORE INTO app_meta (key, value) SELECT key, value FROM sync_metadata`);

    // 5. Indicadores
    db.run(`CREATE TABLE IF NOT EXISTS indicadores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT UNIQUE NOT NULL
    )`);

    // 6. Actividades (CORREGIDO: sync_uid ANTES de FOREIGN KEY)
    db.run(`CREATE TABLE IF NOT EXISTS actividades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proyecto_id INTEGER,
        descripcion TEXT NOT NULL,
        sync_uid TEXT UNIQUE,
        FOREIGN KEY(proyecto_id) REFERENCES proyectos(id)
    )`);

    // 7. Seguimientos (CORREGIDO: sync_uid ANTES de FOREIGN KEY)
    db.run(`CREATE TABLE IF NOT EXISTS seguimientos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proyecto_id INTEGER,
        actividad_id INTEGER,
        sede_id INTEGER,
        indicador_id INTEGER,
        porcentaje_avance REAL,
        fecha_seguimiento TEXT,
        responsable TEXT,
        observaciones TEXT,
        es_adicion INTEGER DEFAULT 0,
        valor_adicion REAL DEFAULT 0,
        fuente_adicion TEXT, 
        sync_uid TEXT UNIQUE,
        FOREIGN KEY(proyecto_id) REFERENCES proyectos(id),
        FOREIGN KEY(actividad_id) REFERENCES actividades(id),
        FOREIGN KEY(sede_id) REFERENCES sedes(id),
        FOREIGN KEY(indicador_id) REFERENCES indicadores(id)
    )`);

    // Índices y ajustes
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_actividades_unique ON actividades(proyecto_id, descripcion)`);

    // Verificación de integridad de sync_uid (Retrocompatibilidad)
    db.all(`PRAGMA table_info(seguimientos)`, (pragmaErr, columns) => {
        if (pragmaErr) return console.error('❌ Error structure:', pragmaErr.message);

        const ensureSyncUidReady = () => {
            db.run(`UPDATE seguimientos SET sync_uid = lower(hex(randomblob(16))) WHERE sync_uid IS NULL OR sync_uid = ''`, (e) => {
                if(!e) db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_seguimientos_sync_uid ON seguimientos(sync_uid)`);
            });
        };

        if (!columns.some(col => col.name === 'sync_uid')) {
            db.run(`ALTER TABLE seguimientos ADD COLUMN sync_uid TEXT`, (alterErr) => {
                if (!alterErr) ensureSyncUidReady();
            });
        } else {
            ensureSyncUidReady();
        }
    });

    // Carga inicial si está vacío
    db.get("SELECT count(*) as count FROM indicadores", (err, row) => {
        if (!err && row.count === 0) {
            console.log("🌱 Base de datos vacía. Iniciando carga automática...");
            cargarDatosIniciales();
        } else {
            console.log("✅ Datos existentes detectados.");
        }
    });
});

function cargarDatosIniciales() {
    const rutaIndicadores = path.join(__dirname, 'indicadores.xlsx');
    const rutaSedes = path.join(__dirname, 'sedes.xlsx');

    const leerExcelComoBuffer = (ruta) => {
        try {
            if (!fs.existsSync(ruta)) return null;
            return xlsx.read(fs.readFileSync(ruta), { type: 'buffer' });
        } catch (error) { return null; }
    };

    const wbInd = leerExcelComoBuffer(rutaIndicadores);
    if (wbInd) {
        const datos = xlsx.utils.sheet_to_json(wbInd.Sheets[wbInd.SheetNames[0]]);
        console.log(`📊 Procesando ${datos.length} indicadores...`);
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            const stmt = db.prepare("INSERT OR IGNORE INTO indicadores (nombre) VALUES (?)");
            datos.forEach(fila => {
                let nombre = fila['INDICADORES'] || fila['INDICADOR'] || fila['NOMBRE'];
                if (!nombre && Object.keys(fila).length > 0) nombre = fila[Object.keys(fila)[0]];
                if (nombre) stmt.run(nombre.toString().trim().toUpperCase());
            });
            stmt.finalize();
            db.run("COMMIT", () => actualizarMarcaLocal());
        });
    }

    const wbSedes = leerExcelComoBuffer(rutaSedes);
    if (wbSedes) {
        const datos = xlsx.utils.sheet_to_json(wbSedes.Sheets[wbSedes.SheetNames[0]]);
        console.log(`🏫 Procesando ${datos.length} registros geográficos...`);
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            const insertMuni = db.prepare("INSERT OR IGNORE INTO municipios (nombre) VALUES (?)");
            const muniSet = new Set();
            datos.forEach(fila => {
                const mun = (fila['MUNICIPIO'] || '').toString().trim().toUpperCase();
                if (mun && !muniSet.has(mun)) { insertMuni.run(mun); muniSet.add(mun); }
            });
            insertMuni.finalize();

            datos.forEach(fila => {
                const mun = (fila['MUNICIPIO'] || '').toString().trim().toUpperCase();
                const inst = (fila['INSTITUCION'] || '').toString().trim().toUpperCase();
                const sede = (fila['SEDE'] || '').toString().trim().toUpperCase();
                if (mun && inst) {
                    db.run(`INSERT OR IGNORE INTO instituciones (nombre, municipio_id) SELECT ?, id FROM municipios WHERE nombre = ?`, [inst, mun]);
                    if (sede) {
                        db.run(`INSERT OR IGNORE INTO sedes (nombre, institucion_id) SELECT ?, id FROM instituciones WHERE nombre = ? AND municipio_id = (SELECT id FROM municipios WHERE nombre = ?)`, [sede, inst, mun]);
                    }
                }
            });
            db.run("COMMIT", () => actualizarMarcaLocal());
        });
    }
}

function actualizarMarcaLocal() {
    db.run(`INSERT INTO app_meta (key, value) VALUES ('local_last_change_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [new Date().toISOString()]);
}

module.exports = db;