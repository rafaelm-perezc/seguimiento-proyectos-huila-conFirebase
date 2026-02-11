const path = require('path');
const xlsx = require('xlsx');
const fs = require('fs');

// --- CORRECCIÓN IMPORTANTE ---
// Importamos la instancia 'db' desde database.js.
// Esto asegura que los comandos CREATE TABLE se ejecuten antes de intentar insertar datos.
const db = require('./database'); 

// Nombres de los archivos Excel
const FILE_INDICADORES = path.resolve(__dirname, 'indicadores.xlsx');
const FILE_SEDES = path.resolve(__dirname, 'sedes.xlsx');

const seedData = async () => {
    // Esperamos un momento breve para asegurar que la conexión de database.js esté lista
    // (Aunque sqlite3 maneja cola de operaciones, esto es una seguridad extra)
    setTimeout(async () => {
        console.log('--- Iniciando Carga de Datos ---');

        try {
            // 1. CARGAR INDICADORES
            if (fs.existsSync(FILE_INDICADORES)) {
                console.log('Leyendo indicadores...');
                const workbook = xlsx.readFile(FILE_INDICADORES);
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                const data = xlsx.utils.sheet_to_json(sheet);

                db.serialize(() => {
                    const stmt = db.prepare("INSERT OR IGNORE INTO indicadores (nombre) VALUES (?)");
                    let count = 0;
                    data.forEach(row => {
                        const nombre = row['INDICADORES'] || Object.values(row)[0];
                        if (nombre) {
                            stmt.run(nombre.trim());
                            count++;
                        }
                    });
                    stmt.finalize();
                    console.log(`✅ ${count} Indicadores procesados (o ya existentes).`);
                });
            } else {
                console.warn(`⚠️ Archivo ${FILE_INDICADORES} no encontrado.`);
            }

            // 2. CARGAR MUNICIPIOS, INSTITUCIONES Y SEDES
            if (fs.existsSync(FILE_SEDES)) {
                console.log('Leyendo estructura educativa (Sedes)...');
                const workbook = xlsx.readFile(FILE_SEDES);
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                const data = xlsx.utils.sheet_to_json(sheet);

                await processSedes(data);
            } else {
                console.warn(`⚠️ Archivo ${FILE_SEDES} no encontrado.`);
            }

        } catch (error) {
            console.error("Error general en seeders:", error);
        }
    }, 1000); // Espera 1 segundo antes de iniciar
};

// Función para procesar la jerarquía educativa
async function processSedes(data) {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");

            const insertMunicipio = db.prepare("INSERT OR IGNORE INTO municipios (nombre) VALUES (?)");
            // Nota: SQLite inserta, pero necesitamos el ID. Como es IGNORE, si existe no hace nada.
            // Para las relaciones, haremos subconsultas directas en el INSERT para asegurar consistencia.
            
            const insertInstitucion = db.prepare(`
                INSERT OR IGNORE INTO instituciones (nombre, municipio_id) 
                SELECT ?, id FROM municipios WHERE nombre = ?
            `);

            const insertSede = db.prepare(`
                INSERT OR IGNORE INTO sedes (nombre, institucion_id) 
                SELECT ?, id FROM instituciones 
                WHERE nombre = ? AND municipio_id = (SELECT id FROM municipios WHERE nombre = ?)
            `);

            let processed = 0;
            
            data.forEach(row => {
                const mun = row['MUNICIPIO'] ? row['MUNICIPIO'].toString().trim() : null;
                const inst = row['INSTITUCION'] ? row['INSTITUCION'].toString().trim() : null;
                const sede = row['SEDE'] ? row['SEDE'].toString().trim() : null;

                if (mun && inst && sede) {
                    insertMunicipio.run(mun);
                    insertInstitucion.run(inst, mun);
                    insertSede.run(sede, inst, mun);
                    processed++;
                }
            });

            insertMunicipio.finalize();
            insertInstitucion.finalize();
            insertSede.finalize();

            db.run("COMMIT", (err) => {
                if (err) {
                    console.error("Error en commit:", err);
                    db.run("ROLLBACK");
                    reject(err);
                } else {
                    console.log(`✅ Registros de Sedes procesados.`);
                    console.log('--- Carga Finalizada. Presiona Ctrl + C para salir ---');
                    resolve();
                }
            });
        });
    });
}

// Ejecutar
if (require.main === module) {
    seedData();
}

module.exports = seedData;