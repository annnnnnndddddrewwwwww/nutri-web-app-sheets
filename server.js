// backend/server.js
require('dotenv').config();

const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid'); // Para generar IDs únicos

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Configuración de la autenticación de Google Sheets API
const auth = new google.auth.GoogleAuth({
    credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'), // Importante para los saltos de línea
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'], // Permiso para leer y escribir en Sheets
});

const sheets = google.sheets({ version: 'v4', auth });
const spreadsheetId = process.env.GOOGLE_SHEET_ID;

// --- Funciones auxiliares para interactuar con Google Sheets ---
// (Estas son muy básicas, necesitarían más manejo de errores y validación)

// Función para leer datos de una hoja
async function getSheetData(range) {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range,
        });
        return response.data.values || []; // Devuelve un array de arrays
    } catch (error) {
        console.error(`Error al leer la hoja ${range}:`, error.message);
        throw new Error(`No se pudo leer la hoja ${range}`);
    }
}

// Función para añadir una fila a una hoja
async function appendRow(range, rowData) {
    try {
        const response = await sheets.spreadsheets.values.append({
            spreadsheetId,
            range,
            valueInputOption: 'RAW', // Los valores se insertan tal cual
            insertDataOption: 'INSERT_ROWS',
            resource: {
                values: [rowData],
            },
        });
        return response.data;
    } catch (error) {
        console.error(`Error al añadir fila a ${range}:`, error.message);
        throw new Error(`No se pudo añadir la fila a ${range}`);
    }
}

// Función para actualizar una fila (por ID, requiere buscar la fila)
async function updateRow(sheetName, id, newRowData) {
    const data = await getSheetData(sheetName);
    if (data.length === 0) throw new Error('Hoja vacía o no encontrada.');

    const headers = data[0];
    const rows = data.slice(1);
    const idColumnIndex = headers.indexOf('id');

    if (idColumnIndex === -1) throw new Error('La hoja no tiene una columna "id".');

    const rowIndexToUpdate = rows.findIndex(row => String(row[idColumnIndex]) === String(id));

    if (rowIndexToUpdate === -1) throw new Error('Registro no encontrado.');

    // Construir la nueva fila, asegurando que el ID no cambie
    const existingRow = rows[rowIndexToUpdate];
    const updatedRow = existingRow.map((cell, index) => {
        const header = headers[index];
        return newRowData[header] !== undefined ? newRowData[header] : cell;
    });
    // Asegurarse que el ID sea el mismo
    updatedRow[idColumnIndex] = existingRow[idColumnIndex];

    // Rango para actualizar: sheetName!A<fila_real>:Z<fila_real>
    const actualRowInSheet = rowIndexToUpdate + 2; // +1 por los encabezados, +1 por ser 1-indexed
    const range = `${sheetName}!A${actualRowInSheet}`;

    try {
        const response = await sheets.spreadsheets.values.update({
            spreadsheetId,
            range,
            valueInputOption: 'RAW',
            resource: {
                values: [updatedRow],
            },
        });
        return response.data;
    } catch (error) {
        console.error(`Error al actualizar fila en ${sheetName}:`, error.message);
        throw new Error(`No se pudo actualizar la fila en ${sheetName}`);
    }
}

// --- Rutas de API REST ---

// Ruta de prueba
app.get('/', (req, res) => {
    res.send('¡Servidor de Nutri-Web funcionando con Google Sheets!');
});

// --- Rutas para `users` ---
app.post('/api/users/register', async (req, res) => {
    try {
        const { username, email, password_hash, full_name, role = 'client' } = req.body;
        if (!username || !email || !password_hash) {
            return res.status(400).json({ error: 'Faltan campos obligatorios.' });
        }

        // Simular búsqueda de duplicados (Google Sheets no tiene UNIQUE)
        const existingUsers = await getSheetData('users');
        if (existingUsers.slice(1).some(row => row[2] === email)) { // email está en la columna 2 (índice 2)
            return res.status(409).json({ error: 'El email ya está registrado.' });
        }
        if (existingUsers.slice(1).some(row => row[1] === username)) { // username está en la columna 1 (índice 1)
            return res.status(409).json({ error: 'El nombre de usuario ya está en uso.' });
        }

        // Generar ID único (simple secuencial para ejemplo, en prod usar UUID o un contador persistente)
        const newId = existingUsers.length > 1 ? Math.max(...existingUsers.slice(1).map(row => parseInt(row[0] || 0))) + 1 : 1;

        const newUserData = [
            newId,
            username,
            email,
            password_hash, // En una app real, aquí usarías bcrypt para hashear
            full_name || '',
            role,
            new Date().toISOString()
        ];
        await appendRow('users', newUserData);
        res.status(201).json({ message: 'Usuario registrado con éxito', id: newId });
    } catch (error) {
        console.error('Error al registrar usuario:', error);
        res.status(500).json({ error: 'Error interno del servidor al registrar usuario.' });
    }
});

// --- Rutas para `products` ---
app.get('/api/products', async (req, res) => {
    try {
        const productsData = await getSheetData('products');
        if (productsData.length === 0) return res.json([]);

        const headers = productsData[0];
        const products = productsData.slice(1).map(row => {
            const product = {};
            headers.forEach((header, index) => {
                product[header] = row[index];
            });
            return product;
        });
        res.json(products);
    } catch (error) {
        console.error('Error al obtener productos:', error);
        res.status(500).json({ error: 'Error interno del servidor al obtener productos.' });
    }
});

// (Para otras operaciones como añadir/actualizar productos, citas, etc. necesitarías implementar funciones similares
// usando `appendRow`, `updateRow` y `getSheetData` con lógica para buscar/filtrar)

// Ejemplo de añadir un producto (simplicado, solo para demostración)
app.post('/api/products', async (req, res) => {
    try {
        const { name, description, price, file_url, category, image_url, is_active = true } = req.body;
        if (!name || !price) {
            return res.status(400).json({ error: 'Faltan nombre y precio del producto.' });
        }

        const productsData = await getSheetData('products');
        const newId = productsData.length > 1 ? Math.max(...productsData.slice(1).map(row => parseInt(row[0] || 0))) + 1 : 1;

        const newProductData = [
            newId,
            name,
            description || '',
            parseFloat(price),
            file_url || '',
            category || '',
            image_url || '',
            is_active,
            new Date().toISOString()
        ];
        await appendRow('products', newProductData);
        res.status(201).json({ message: 'Producto añadido con éxito', id: newId });
    } catch (error) {
        console.error('Error al añadir producto:', error);
        res.status(500).json({ error: 'Error interno del servidor al añadir producto.' });
    }
});


// Iniciar el servidor
app.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});