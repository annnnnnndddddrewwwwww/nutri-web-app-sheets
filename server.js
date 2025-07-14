// backend/server.js
require('dotenv').config();

const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid'); // Para generar IDs únicos si quieres UUIDs
// const bcrypt = require('bcrypt'); // Para hashear contraseñas - ¡muy recomendado para producción!

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors()); // Habilita CORS para todas las rutas
app.use(express.json()); // Permite a Express parsear JSON en el cuerpo de las solicitudes

// --- Configuración de Google Sheets API ---
const auth = new google.auth.GoogleAuth({
    credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'), // Importante para los saltos de línea
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'], // Permiso para leer y escribir en Sheets
});

const sheets = google.sheets({ version: 'v4', auth });
const spreadsheetId = process.env.GOOGLE_SHEET_ID;

// --- Funciones Auxiliares para Google Sheets ---
/**
 * Lee todos los datos de una hoja (incluyendo encabezados).
 * @param {string} sheetName El nombre de la hoja (pestaña) a leer.
 * @returns {Promise<Array<Array<string>>>} Un array de arrays, donde el primer array son los encabezados.
 */
async function getSheetData(sheetName) {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: sheetName,
        });
        return response.data.values || [];
    } catch (error) {
        console.error(`Error al leer la hoja ${sheetName}:`, error.message);
        throw new Error(`No se pudo leer la hoja ${sheetName}`);
    }
}

/**
 * Añade una nueva fila a una hoja.
 * @param {string} sheetName El nombre de la hoja.
 * @param {Array<string|number|boolean>} rowData Los datos de la nueva fila, en el orden de los encabezados.
 * @returns {Promise<Object>} La respuesta de la API de Google Sheets.
 */
async function appendRow(sheetName, rowData) {
    try {
        const response = await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: sheetName,
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            resource: {
                values: [rowData],
            },
        });
        return response.data;
    } catch (error) {
        console.error(`Error al añadir fila a ${sheetName}:`, error.message);
        throw new Error(`No se pudo añadir la fila a ${sheetName}`);
    }
}

/**
 * Actualiza una fila existente por ID en una hoja.
 * @param {string} sheetName El nombre de la hoja.
 * @param {string|number} id El ID del registro a actualizar.
 * @param {Object} newFields Los campos a actualizar (key-value, donde key es el nombre del encabezado).
 * @returns {Promise<Object>} La respuesta de la API de Google Sheets.
 */
async function updateRowById(sheetName, id, newFields) {
    const data = await getSheetData(sheetName);
    if (data.length === 0) {
        throw new Error(`Hoja '${sheetName}' vacía o no encontrada.`);
    }

    const headers = data[0];
    const rows = data.slice(1);
    const idColumnIndex = headers.indexOf('id');

    if (idColumnIndex === -1) {
        throw new Error(`La hoja '${sheetName}' no tiene una columna "id".`);
    }

    // Buscar el índice de la fila en el array de 'rows' (sin encabezados)
    const rowIndexInRowsArray = rows.findIndex(row => String(row[idColumnIndex]) === String(id));

    if (rowIndexInRowsArray === -1) {
        throw new Error(`Registro con ID ${id} no encontrado en la hoja '${sheetName}'.`);
    }

    // Calcular el índice real de la fila en la hoja de Google (1-indexed, +1 por encabezado)
    const actualRowInSheet = rowIndexInRowsArray + 2;

    // Crear la fila actualizada mezclando los datos existentes con los nuevos
    const existingRow = rows[rowIndexInRowsArray];
    const updatedRow = [...existingRow]; // Copia de la fila existente

    for (const key in newFields) {
        const headerIndex = headers.indexOf(key);
        if (headerIndex !== -1) {
            updatedRow[headerIndex] = newFields[key];
        }
    }

    const range = `${sheetName}!A${actualRowInSheet}`; // Rango para actualizar solo esa fila

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
        console.error(`Error al actualizar fila en ${sheetName} (ID: ${id}):`, error.message);
        throw new Error(`No se pudo actualizar la fila en ${sheetName}.`);
    }
}

/**
 * Elimina una fila por ID de una hoja.
 * @param {string} sheetName El nombre de la hoja.
 * @param {string|number} id El ID del registro a eliminar.
 * @returns {Promise<Object>} La respuesta de la API de Google Sheets.
 */
async function deleteRowById(sheetName, id) {
    const data = await getSheetData(sheetName);
    if (data.length === 0) {
        throw new Error(`Hoja '${sheetName}' vacía o no encontrada.`);
    }

    const headers = data[0];
    const rows = data.slice(1);
    const idColumnIndex = headers.indexOf('id');

    if (idColumnIndex === -1) {
        throw new Error(`La hoja '${sheetName}' no tiene una columna "id".`);
    }

    const rowIndexInRowsArray = rows.findIndex(row => String(row[idColumnIndex]) === String(id));

    if (rowIndexInRowsArray === -1) {
        throw new Error(`Registro con ID ${id} no encontrado en la hoja '${sheetName}'.`);
    }

    const actualRowInSheet = rowIndexInRowsArray + 2; // +1 por encabezados, +1 por ser 1-indexed

    // Para eliminar, debemos usar batchUpdate y pedir que se eliminen las filas
    try {
        const response = await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            resource: {
                requests: [{
                    deleteDimension: {
                        range: {
                            sheetIndex: data.indexOf(headers), // Encontrar el índice de la hoja
                            dimension: 'ROWS',
                            startIndex: actualRowInSheet - 1, // API es 0-indexed para startIndex
                            endIndex: actualRowInSheet // endIndex es exclusivo
                        }
                    }
                }]
            }
        });
        return response.data;
    } catch (error) {
        console.error(`Error al eliminar fila en ${sheetName} (ID: ${id}):`, error.message);
        throw new Error(`No se pudo eliminar la fila en ${sheetName}.`);
    }
}

/**
 * Convierte un array de arrays (datos de Sheets) a un array de objetos.
 * @param {Array<Array<string>>} sheetData Los datos obtenidos de Google Sheets.
 * @returns {Array<Object>} Un array de objetos con las claves de los encabezados.
 */
function rowsToObjects(sheetData) {
    if (!sheetData || sheetData.length === 0) return [];
    const headers = sheetData[0];
    return sheetData.slice(1).map(row => {
        const obj = {};
        headers.forEach((header, index) => {
            obj[header] = row[index];
        });
        return obj;
    });
}

// --- Rutas de API REST ---

// Ruta de prueba general
app.get('/', (req, res) => {
    res.send('¡Servidor de Nutri-Web funcionando con Google Sheets y APIs!');
});

// --- API para `users` ---
app.post('/api/users/register', async (req, res) => {
    try {
        const { username, email, password, full_name, role = 'client' } = req.body;
        if (!username || !email || !password) {
            return res.status(400).json({ error: 'Faltan campos obligatorios: username, email, password.' });
        }

        const users = await getSheetData('users');
        const usersAsObjects = rowsToObjects(users);

        // Validar duplicados
        if (usersAsObjects.some(user => user.email === email)) {
            return res.status(409).json({ error: 'El email ya está registrado.' });
        }
        if (usersAsObjects.some(user => user.username === username)) {
            return res.status(409).json({ error: 'El nombre de usuario ya está en uso.' });
        }

        // Generar ID (simple secuencial, podrías usar uuidv4() para UUIDs)
        const newId = usersAsObjects.length > 0 ? Math.max(...usersAsObjects.map(u => parseInt(u.id) || 0)) + 1 : 1;

        // Hashear la contraseña (descomenta si instalas bcrypt)
        // const password_hash = await bcrypt.hash(password, 10);
        const password_hash = password; // POR AHORA, SIN HASHING - ¡NO USAR EN PRODUCCIÓN!

        const newUserData = [
            newId,
            username,
            email,
            password_hash,
            full_name || '',
            role,
            new Date().toISOString()
        ];
        await appendRow('users', newUserData);
        res.status(201).json({ message: 'Usuario registrado con éxito', user: { id: newId, username, email, full_name, role } });
    } catch (error) {
        console.error('Error al registrar usuario:', error);
        res.status(500).json({ error: 'Error interno del servidor al registrar usuario.' });
    }
});

app.get('/api/users', async (req, res) => {
    try {
        const users = await getSheetData('users');
        res.json(rowsToObjects(users));
    } catch (error) {
        console.error('Error al obtener usuarios:', error);
        res.status(500).json({ error: 'Error interno del servidor al obtener usuarios.' });
    }
});

app.get('/api/users/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const users = await getSheetData('users');
        const user = rowsToObjects(users).find(u => String(u.id) === String(id));
        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado.' });
        }
        res.json(user);
    } catch (error) {
        console.error('Error al obtener usuario por ID:', error);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

app.put('/api/users/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { username, email, full_name, role } = req.body; // No se permite actualizar la contraseña por esta ruta
        const updatedFields = { username, email, full_name, role };

        // Filtrar campos undefined para no sobrescribir con valores nulos
        Object.keys(updatedFields).forEach(key => updatedFields[key] === undefined && delete updatedFields[key]);

        await updateRowById('users', id, updatedFields);
        res.json({ message: 'Usuario actualizado con éxito.' });
    } catch (error) {
        console.error('Error al actualizar usuario:', error);
        res.status(500).json({ error: error.message || 'Error interno del servidor al actualizar usuario.' });
    }
});

app.delete('/api/users/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await deleteRowById('users', id);
        res.json({ message: 'Usuario eliminado con éxito.' });
    } catch (error) {
        console.error('Error al eliminar usuario:', error);
        res.status(500).json({ error: error.message || 'Error interno del servidor al eliminar usuario.' });
    }
});

// --- API para `products` ---
app.post('/api/products', async (req, res) => {
    try {
        const { name, description, price, file_url, category, image_url, is_active = true } = req.body;
        if (!name || !price) {
            return res.status(400).json({ error: 'Faltan campos obligatorios: name, price.' });
        }

        const products = await getSheetData('products');
        const productsAsObjects = rowsToObjects(products);

        if (productsAsObjects.some(p => p.name === name)) {
            return res.status(409).json({ error: 'Ya existe un producto con este nombre.' });
        }

        const newId = productsAsObjects.length > 0 ? Math.max(...productsAsObjects.map(p => parseInt(p.id) || 0)) + 1 : 1;

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
        res.status(201).json({ message: 'Producto añadido con éxito', product: { id: newId, name } });
    } catch (error) {
        console.error('Error al añadir producto:', error);
        res.status(500).json({ error: 'Error interno del servidor al añadir producto.' });
    }
});

app.get('/api/products', async (req, res) => {
    try {
        const products = await getSheetData('products');
        res.json(rowsToObjects(products));
    } catch (error) {
        console.error('Error al obtener productos:', error);
        res.status(500).json({ error: 'Error interno del servidor al obtener productos.' });
    }
});

app.get('/api/products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const products = await getSheetData('products');
        const product = rowsToObjects(products).find(p => String(p.id) === String(id));
        if (!product) {
            return res.status(404).json({ error: 'Producto no encontrado.' });
        }
        res.json(product);
    } catch (error) {
        console.error('Error al obtener producto por ID:', error);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

app.put('/api/products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description, price, file_url, category, image_url, is_active } = req.body;
        const updatedFields = { name, description, price: price ? parseFloat(price) : undefined, file_url, category, image_url, is_active };

        Object.keys(updatedFields).forEach(key => updatedFields[key] === undefined && delete updatedFields[key]);

        await updateRowById('products', id, updatedFields);
        res.json({ message: 'Producto actualizado con éxito.' });
    } catch (error) {
        console.error('Error al actualizar producto:', error);
        res.status(500).json({ error: error.message || 'Error interno del servidor al actualizar producto.' });
    }
});

app.delete('/api/products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await deleteRowById('products', id);
        res.json({ message: 'Producto eliminado con éxito.' });
    } catch (error) {
        console.error('Error al eliminar producto:', error);
        res.status(500).json({ error: error.message || 'Error interno del servidor al eliminar producto.' });
    }
});

// --- API para `nutrition_plans` ---
app.post('/api/nutrition-plans', async (req, res) => {
    try {
        const { name, description, price, duration_minutes, is_active = true } = req.body;
        if (!name || !price || !duration_minutes) {
            return res.status(400).json({ error: 'Faltan campos obligatorios: name, price, duration_minutes.' });
        }

        const plans = await getSheetData('nutrition_plans');
        const plansAsObjects = rowsToObjects(plans);

        if (plansAsObjects.some(p => p.name === name)) {
            return res.status(409).json({ error: 'Ya existe un plan nutricional con este nombre.' });
        }

        const newId = plansAsObjects.length > 0 ? Math.max(...plansAsObjects.map(p => parseInt(p.id) || 0)) + 1 : 1;

        const newPlanData = [
            newId,
            name,
            description || '',
            parseFloat(price),
            parseInt(duration_minutes),
            is_active,
            new Date().toISOString()
        ];
        await appendRow('nutrition_plans', newPlanData);
        res.status(201).json({ message: 'Plan nutricional añadido con éxito', plan: { id: newId, name } });
    } catch (error) {
        console.error('Error al añadir plan nutricional:', error);
        res.status(500).json({ error: 'Error interno del servidor al añadir plan nutricional.' });
    }
});

app.get('/api/nutrition-plans', async (req, res) => {
    try {
        const plans = await getSheetData('nutrition_plans');
        res.json(rowsToObjects(plans));
    } catch (error) {
        console.error('Error al obtener planes nutricionales:', error);
        res.status(500).json({ error: 'Error interno del servidor al obtener planes nutricionales.' });
    }
});

app.get('/api/nutrition-plans/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const plans = await getSheetData('nutrition_plans');
        const plan = rowsToObjects(plans).find(p => String(p.id) === String(id));
        if (!plan) {
            return res.status(404).json({ error: 'Plan nutricional no encontrado.' });
        }
        res.json(plan);
    } catch (error) {
        console.error('Error al obtener plan nutricional por ID:', error);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

app.put('/api/nutrition-plans/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description, price, duration_minutes, is_active } = req.body;
        const updatedFields = { name, description, price: price ? parseFloat(price) : undefined, duration_minutes: duration_minutes ? parseInt(duration_minutes) : undefined, is_active };

        Object.keys(updatedFields).forEach(key => updatedFields[key] === undefined && delete updatedFields[key]);

        await updateRowById('nutrition_plans', id, updatedFields);
        res.json({ message: 'Plan nutricional actualizado con éxito.' });
    } catch (error) {
        console.error('Error al actualizar plan nutricional:', error);
        res.status(500).json({ error: error.message || 'Error interno del servidor al actualizar plan nutricional.' });
    }
});

app.delete('/api/nutrition-plans/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await deleteRowById('nutrition_plans', id);
        res.json({ message: 'Plan nutricional eliminado con éxito.' });
    } catch (error) {
        console.error('Error al eliminar plan nutricional:', error);
        res.status(500).json({ error: error.message || 'Error interno del servidor al eliminar plan nutricional.' });
    }
});

// --- API para `appointments` ---
app.post('/api/appointments', async (req, res) => {
    try {
        const { user_id, plan_id, appointment_date, appointment_time, notes } = req.body;
        if (!user_id || !plan_id || !appointment_date || !appointment_time) {
            return res.status(400).json({ error: 'Faltan campos obligatorios: user_id, plan_id, appointment_date, appointment_time.' });
        }

        // Validación simple: verificar si user_id y plan_id existen
        const users = rowsToObjects(await getSheetData('users'));
        if (!users.some(u => String(u.id) === String(user_id))) {
            return res.status(400).json({ error: 'El user_id proporcionado no existe.' });
        }
        const plans = rowsToObjects(await getSheetData('nutrition_plans'));
        if (!plans.some(p => String(p.id) === String(plan_id))) {
            return res.status(400).json({ error: 'El plan_id proporcionado no existe.' });
        }

        const appointments = await getSheetData('appointments');
        const appointmentsAsObjects = rowsToObjects(appointments);
        const newId = appointmentsAsObjects.length > 0 ? Math.max(...appointmentsAsObjects.map(a => parseInt(a.id) || 0)) + 1 : 1;

        const newAppointmentData = [
            newId,
            user_id,
            plan_id,
            appointment_date,
            appointment_time,
            'pending', // Estado inicial
            notes || '',
            new Date().toISOString()
        ];
        await appendRow('appointments', newAppointmentData);
        res.status(201).json({ message: 'Cita reservada con éxito', appointment: { id: newId, user_id, plan_id, appointment_date, appointment_time } });
    } catch (error) {
        console.error('Error al reservar cita:', error);
        res.status(500).json({ error: 'Error interno del servidor al reservar cita.' });
    }
});

app.get('/api/appointments', async (req, res) => {
    try {
        const appointments = await getSheetData('appointments');
        const appointmentsAsObjects = rowsToObjects(appointments);

        // Puedes añadir aquí lógica para filtrar por user_id, date, status, etc.
        // Ejemplo: const { userId, date } = req.query;
        // if (userId) appointmentsAsObjects = appointmentsAsObjects.filter(a => String(a.user_id) === String(userId));

        res.json(appointmentsAsObjects);
    } catch (error) {
        console.error('Error al obtener citas:', error);
        res.status(500).json({ error: 'Error interno del servidor al obtener citas.' });
    }
});

app.get('/api/appointments/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const appointments = await getSheetData('appointments');
        const appointment = rowsToObjects(appointments).find(a => String(a.id) === String(id));
        if (!appointment) {
            return res.status(404).json({ error: 'Cita no encontrada.' });
        }
        res.json(appointment);
    } catch (error) {
        console.error('Error al obtener cita por ID:', error);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

app.put('/api/appointments/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { user_id, plan_id, appointment_date, appointment_time, status, notes } = req.body;
        const updatedFields = { user_id, plan_id, appointment_date, appointment_time, status, notes };

        Object.keys(updatedFields).forEach(key => updatedFields[key] === undefined && delete updatedFields[key]);

        await updateRowById('appointments', id, updatedFields);
        res.json({ message: 'Cita actualizada con éxito.' });
    } catch (error) {
        console.error('Error al actualizar cita:', error);
        res.status(500).json({ error: error.message || 'Error interno del servidor al actualizar cita.' });
    }
});

app.delete('/api/appointments/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await deleteRowById('appointments', id);
        res.json({ message: 'Cita eliminada con éxito.' });
    } catch (error) {
        console.error('Error al eliminar cita:', error);
        res.status(500).json({ error: error.message || 'Error interno del servidor al eliminar cita.' });
    }
});

// --- API para `orders` y `order_items` ---
// (Estas rutas son más complejas por la relación, las implementaremos en el futuro si la venta es crucial)

// Iniciar el servidor
app.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});