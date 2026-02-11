const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

// Ruta a tu base de datos
const dbPath = path.join(__dirname, 'src', 'db', 'proyectos_huila.db');
const db = new sqlite3.Database(dbPath);

console.log("🛠️  Iniciando reparación de base de datos (Versión Corregida)...");

db.serialize(() => {
    // PASO 1: Agregar la columna SIN la restricción UNIQUE
    // Esto evita el error "Cannot add a UNIQUE column"
    db.run("ALTER TABLE seguimientos ADD COLUMN sync_uid TEXT", (err) => {
        if (err) {
            if (err.message.includes('duplicate column')) {
                console.log("ℹ️  La columna 'sync_uid' ya existía.");
            } else {
                console.error("❌ Error crítico agregando columna:", err.message);
                return;
            }
        } else {
            console.log("✅ Columna 'sync_uid' creada correctamente.");
        }

        // PASO 2: Proceder a llenar los datos (solo si el paso 1 no fue un error crítico)
        procesarDatos();
    });
});

function procesarDatos() {
    db.all("SELECT id FROM seguimientos WHERE sync_uid IS NULL OR sync_uid = ''", (err, rows) => {
        if (err) {
            console.error("❌ Error leyendo la tabla seguimientos. ¿Seguro que se creó la columna?", err.message);
            return;
        }

        console.log(`🔍 Encontrados ${rows.length} seguimientos que necesitan reparación.`);

        if (rows.length === 0) {
            crearIndiceYSalir();
            return;
        }

        const stmt = db.prepare("UPDATE seguimientos SET sync_uid = ? WHERE id = ?");
        let procesados = 0;

        rows.forEach((row) => {
            const newUid = crypto.randomUUID();
            stmt.run(newUid, row.id, (updateErr) => {
                if (updateErr) console.error(`Error en ID ${row.id}:`, updateErr);
                
                procesados++;
                if (procesados === rows.length) {
                    stmt.finalize(() => {
                        console.log(`✅ Se generaron IDs para ${rows.length} registros.`);
                        crearIndiceYSalir();
                    });
                }
            });
        });
    });
}

function crearIndiceYSalir() {
    // PASO 3: Ahora que hay datos, creamos la restricción de unicidad mediante un ÍNDICE
    db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_seguimientos_sync_uid ON seguimientos(sync_uid)", (err) => {
        if (err) {
            console.error("⚠️ Advertencia creando índice (no afecta la sincronización):", err.message);
        } else {
            console.log("🔒 Índice de seguridad (UNIQUE) creado correctamente.");
        }
        
        console.log("\n🚀 ¡LISTO! Reparación terminada. Ejecuta 'npm start' para sincronizar.");
        db.close();
    });
}