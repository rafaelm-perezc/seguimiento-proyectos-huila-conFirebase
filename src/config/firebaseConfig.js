// src/config/firebaseConfig.js
const { initializeApp } = require("firebase/app");
const { getDatabase } = require("firebase/database");
const { getAuth, signInAnonymously } = require("firebase/auth");

const firebaseConfig = {
  apiKey: "AIzaSyAPFFGHNsuACJXI53aMEMuhblaYaM1GRn4",
  authDomain: "segproyectoshuila.firebaseapp.com",
  databaseURL: "https://segproyectoshuila-default-rtdb.firebaseio.com",
  projectId: "segproyectoshuila",
  storageBucket: "segproyectoshuila.firebasestorage.app",
  messagingSenderId: "463333164381",
  appId: "1:463333164381:web:27a0936f83277122e494b4",
  measurementId: "G-914WW888S1"
};

// Inicializamos la app
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);

// Autenticación Anónima (necesaria para escribir si las reglas no son públicas)
async function connectFirebase() {
    try {
        if (!auth.currentUser) {
            await signInAnonymously(auth);
            console.log("🔥 Conectado a Firebase (Modo Cliente en Servidor)");
        }
        return db;
    } catch (error) {
        console.error("❌ Error conectando a Firebase:", error.message);
        throw error;
    }
}

module.exports = { db, connectFirebase };