// backend/server.js
require('dotenv').config();

const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt'); // Importa bcrypt
const jwt = require('jsonwebtoken'); // Importa jsonwebtoken

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// --- Configuración de Google Sheets API ---
const auth = new google.auth.GoogleAuth({
    credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });
const spreadsheetId = process.env.GOOGLE_SHEET_ID;
const JWT_SECRET = process.env.JWT_SECRET; // Obtén la clave secreta del .env

// --- Funciones Auxiliares para Google Sheets (las mismas que antes, no cambian) ---
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

    const rowIndexInRowsArray = rows.findIndex(row => String(row[idColumnIndex]) === String(id));

    if (rowIndexInRowsArray === -1) {
        throw new Error(`Registro con ID ${id} no encontrado en la hoja '${sheetName}'.`);
    }

    const actualRowInSheet = rowIndexInRowsArray + 2;

    const existingRow = rows[rowIndexInRowsArray];
    const updatedRow = [...existingRow];

    for (const key in newFields) {
        const headerIndex = headers.indexOf(key);
        if (headerIndex !== -1) {
            updatedRow[headerIndex] = newFields[key];
        }
    }

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
        console.error(`Error al actualizar fila en ${sheetName} (ID: ${id}):`, error.message);
        throw new Error(`No se pudo actualizar la fila en ${sheetName}.`);
    }
}

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

    const actualRowInSheet = rowIndexInRowsArray + 2;

    try {
        const response = await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            resource: {
                requests: [{
                    deleteDimension: {
                        range: {
                            sheetIndex: data.indexOf(headers), // Este índice podría ser problemático si hay muchas hojas y la API no devuelve el índice correcto. Podrías hardcodear el índice de la hoja si sabes que no cambiará o buscarlo de forma más robusta.
                            dimension: 'ROWS',
                            startIndex: actualRowInSheet - 1,
                            endIndex: actualRowInSheet
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

// --- Middleware de Autenticación JWT ---
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Formato: Bearer TOKEN

    if (token == null) return res.status(401).json({ error: 'Token no proporcionado.' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Token inválido o expirado.' });
        req.user = user; // Guarda la información del usuario en la solicitud
        next();
    });
}

// --- Middleware de Autorización por Roles ---
function authorizeRoles(...roles) {
    return (req, res, next) => {
        if (!req.user || !req.user.role || !roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'No tienes permisos para realizar esta acción.' });
        }
        next();
    };
}


// --- Rutas de API REST ---

// Ruta de prueba general (pública)
app.get('/', (req, res) => {
    res.send('¡Servidor de Nutri-Web funcionando con Google Sheets y APIs, con seguridad JWT!');
});

// --- API para `Auth` (Registro y Login) ---
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, email, password, full_name, role = 'client' } = req.body;
        if (!username || !email || !password) {
            return res.status(400).json({ error: 'Faltan campos obligatorios: username, email, password.' });
        }

        const users = await getSheetData('users');
        const usersAsObjects = rowsToObjects(users);

        if (usersAsObjects.some(user => user.email === email)) {
            return res.status(409).json({ error: 'El email ya está registrado.' });
        }
        if (usersAsObjects.some(user => user.username === username)) {
            return res.status(409).json({ error: 'El nombre de usuario ya está en uso.' });
        }

        const newId = usersAsObjects.length > 0 ? Math.max(...usersAsObjects.map(u => parseInt(u.id) || 0)) + 1 : 1;
        const password_hash = await bcrypt.hash(password, 10); // Hashea la contraseña

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

        // Generar JWT para el nuevo usuario (opcional, podrías solo registrar y pedirle que haga login)
        const token = jwt.sign({ id: newId, username, email, role }, JWT_SECRET, { expiresIn: '1h' });

        res.status(201).json({ message: 'Usuario registrado con éxito', token, user: { id: newId, username, email, role } });
    } catch (error) {
        console.error('Error al registrar usuario:', error);
        res.status(500).json({ error: 'Error interno del servidor al registrar usuario.' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Faltan campos obligatorios: email, password.' });
        }

        const users = await getSheetData('users');
        const usersAsObjects = rowsToObjects(users);
        const user = usersAsObjects.find(u => u.email === email);

        if (!user) {
            return res.status(400).json({ error: 'Credenciales inválidas.' });
        }

        // Comparar la contraseña hasheada
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(400).json({ error: 'Credenciales inválidas.' });
        }

        // Generar JWT
        const token = jwt.sign({ id: user.id, username: user.username, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '1h' });

        res.json({ message: 'Inicio de sesión exitoso', token, user: { id: user.id, username: user.username, email: user.email, role: user.role } });
    } catch (error) {
        console.error('Error al iniciar sesión:', error);
        res.status(500).json({ error: 'Error interno del servidor al iniciar sesión.' });
    }
});

// --- Rutas Protegidas ---

// Ejemplo: Solo administradores pueden ver todos los usuarios (aparte de registrarse y su propio perfil)
app.get('/api/users', authenticateToken, authorizeRoles('admin'), async (req, res) => {
    try {
        const users = await getSheetData('users');
        // Quita el hash de contraseña antes de enviar
        const safeUsers = rowsToObjects(users).map(({ password_hash, ...rest }) => rest);
        res.json(safeUsers);
    } catch (error) {
        console.error('Error al obtener usuarios:', error);
        res.status(500).json({ error: 'Error interno del servidor al obtener usuarios.' });
    }
});

// Los usuarios pueden ver su propio perfil
app.get('/api/users/me', authenticateToken, async (req, res) => {
    try {
        const users = await getSheetData('users');
        const user = rowsToObjects(users).find(u => String(u.id) === String(req.user.id));
        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado.' });
        }
        // Quita el hash de contraseña
        const { password_hash, ...safeUser } = user;
        res.json(safeUser);
    } catch (error) {
        console.error('Error al obtener perfil del usuario:', error);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// Solo administradores o el propio usuario pueden actualizar su perfil
app.put('/api/users/:id', authenticateToken, authorizeRoles('admin'), async (req, res) => { // Puedes añadir `|| String(req.user.id) === String(req.params.id)`
    // Lógica para permitir al propio usuario actualizar su perfil:
    // if (req.user.role !== 'admin' && String(req.user.id) !== String(req.params.id)) {
    //     return res.status(403).json({ error: 'No tienes permisos para actualizar este usuario.' });
    // }
    try {
        const { id } = req.params;
        const { username, email, full_name, role } = req.body;
        const updatedFields = { username, email, full_name, role };

        Object.keys(updatedFields).forEach(key => updatedFields[key] === undefined && delete updatedFields[key]);

        await updateRowById('users', id, updatedFields);
        res.json({ message: 'Usuario actualizado con éxito.' });
    } catch (error) {
        console.error('Error al actualizar usuario:', error);
        res.status(500).json({ error: error.message || 'Error interno del servidor al actualizar usuario.' });
    }
});

// Solo administradores pueden eliminar usuarios
app.delete('/api/users/:id', authenticateToken, authorizeRoles('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        await deleteRowById('users', id);
        res.json({ message: 'Usuario eliminado con éxito.' });
    } catch (error) {
        console.error('Error al eliminar usuario:', error);
        res.status(500).json({ error: error.message || 'Error interno del servidor al eliminar usuario.' });
    }
});


// --- API para `products` (Protegidas para Creación/Actualización/Eliminación) ---
// Cualquiera puede ver los productos
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

// Solo administradores pueden añadir/actualizar/eliminar productos
app.post('/api/products', authenticateToken, authorizeRoles('admin'), async (req, res) => {
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
app.put('/api/products/:id', authenticateToken, authorizeRoles('admin'), async (req, res) => {
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
app.delete('/api/products/:id', authenticateToken, authorizeRoles('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        await deleteRowById('products', id);
        res.json({ message: 'Producto eliminado con éxito.' });
    } catch (error) {
        console.error('Error al eliminar producto:', error);
        res.status(500).json({ error: error.message || 'Error interno del servidor al eliminar producto.' });
    }
});

// --- API para `nutrition_plans` (Protegidas para Creación/Actualización/Eliminación) ---
// Cualquiera puede ver los planes
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

// Solo administradores pueden añadir/actualizar/eliminar planes
app.post('/api/nutrition-plans', authenticateToken, authorizeRoles('admin'), async (req, res) => {
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
app.put('/api/nutrition-plans/:id', authenticateToken, authorizeRoles('admin'), async (req, res) => {
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
app.delete('/api/nutrition-plans/:id', authenticateToken, authorizeRoles('admin'), async (req, res) => {
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
// Los usuarios autenticados pueden reservar citas. Los administradores pueden ver todas o las de un usuario específico.
app.post('/api/appointments', authenticateToken, async (req, res) => {
    try {
        const { plan_id, appointment_date, appointment_time, notes } = req.body;
        const user_id = req.user.id; // El ID del usuario viene del token JWT

        if (!user_id || !plan_id || !appointment_date || !appointment_time) {
            return res.status(400).json({ error: 'Faltan campos obligatorios: plan_id, appointment_date, appointment_time.' });
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
            'pending',
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

// Obtener citas (clientes ven las suyas, administradores ven todas o filtran)
app.get('/api/appointments', authenticateToken, async (req, res) => {
    try {
        const appointments = await getSheetData('appointments');
        let appointmentsAsObjects = rowsToObjects(appointments);

        // Los clientes solo ven sus propias citas
        if (req.user.role === 'client') {
            appointmentsAsObjects = appointmentsAsObjects.filter(a => String(a.user_id) === String(req.user.id));
        }
        // Los administradores pueden ver todas o filtrar por user_id si se pasa como query param
        else if (req.user.role === 'admin' && req.query.user_id) {
            appointmentsAsObjects = appointmentsAsObjects.filter(a => String(a.user_id) === String(req.query.user_id));
        }

        res.json(appointmentsAsObjects);
    } catch (error) {
        console.error('Error al obtener citas:', error);
        res.status(500).json({ error: 'Error interno del servidor al obtener citas.' });
    }
});

// Obtener una cita específica (clientes solo las suyas, administradores cualquiera)
app.get('/api/appointments/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const appointments = await getSheetData('appointments');
        const appointment = rowsToObjects(appointments).find(a => String(a.id) === String(id));

        if (!appointment) {
            return res.status(404).json({ error: 'Cita no encontrada.' });
        }

        // Si es cliente y no es su cita, denegar acceso
        if (req.user.role === 'client' && String(appointment.user_id) !== String(req.user.id)) {
            return res.status(403).json({ error: 'No tienes permiso para ver esta cita.' });
        }

        res.json(appointment);
    } catch (error) {
        console.error('Error al obtener cita por ID:', error);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// Actualizar una cita (clientes solo sus propias citas, administradores cualquiera)
app.put('/api/appointments/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { plan_id, appointment_date, appointment_time, status, notes } = req.body;
        const updatedFields = { plan_id, appointment_date, appointment_time, status, notes };

        const appointments = await getSheetData('appointments');
        const appointmentToUpdate = rowsToObjects(appointments).find(a => String(a.id) === String(id));

        if (!appointmentToUpdate) {
            return res.status(404).json({ error: 'Cita no encontrada.' });
        }

        // Si es cliente y no es su cita, o intenta cambiar el user_id, denegar acceso
        if (req.user.role === 'client' && String(appointmentToUpdate.user_id) !== String(req.user.id)) {
            return res.status(403).json({ error: 'No tienes permiso para actualizar esta cita.' });
        }
        // Clientes no pueden cambiar el estado o el user_id
        if (req.user.role === 'client') {
            delete updatedFields.status; // No pueden cambiar el estado
            delete updatedFields.user_id; // No pueden cambiar el usuario asociado
        }

        Object.keys(updatedFields).forEach(key => updatedFields[key] === undefined && delete updatedFields[key]);

        await updateRowById('appointments', id, updatedFields);
        res.json({ message: 'Cita actualizada con éxito.' });
    } catch (error) {
        console.error('Error al actualizar cita:', error);
        res.status(500).json({ error: error.message || 'Error interno del servidor al actualizar cita.' });
    }
});

// Eliminar una cita (clientes solo sus propias citas, administradores cualquiera)
app.delete('/api/appointments/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const appointments = await getSheetData('appointments');
        const appointmentToDelete = rowsToObjects(appointments).find(a => String(a.id) === String(id));

        if (!appointmentToDelete) {
            return res.status(404).json({ error: 'Cita no encontrada.' });
        }

        // Si es cliente y no es su cita, denegar acceso
        if (req.user.role === 'client' && String(appointmentToDelete.user_id) !== String(req.user.id)) {
            return res.status(403).json({ error: 'No tienes permiso para eliminar esta cita.' });
        }

        await deleteRowById('appointments', id);
        res.json({ message: 'Cita eliminada con éxito.' });
    } catch (error) {
        console.error('Error al eliminar cita:', error);
        res.status(500).json({ error: error.message || 'Error interno del servidor al eliminar cita.' });
    }
});


// --- API para `orders` y `order_items` ---
// Implementación básica, esto es más complejo y necesita más lógica para el "carrito de compras" real
// y la integración con pasarelas de pago.

app.post('/api/orders', authenticateToken, async (req, res) => {
    try {
        const { items } = req.body; // items: [{ product_id, quantity }]
        const user_id = req.user.id;
        if (!items || items.length === 0) {
            return res.status(400).json({ error: 'El pedido debe contener al menos un producto.' });
        }

        const products = rowsToObjects(await getSheetData('products'));
        let totalAmount = 0;
        const orderItemsData = [];

        // Validar productos y calcular el total
        for (const item of items) {
            const product = products.find(p => String(p.id) === String(item.product_id));
            if (!product || !product.is_active) {
                return res.status(400).json({ error: `Producto con ID ${item.product_id} no encontrado o inactivo.` });
            }
            const itemPrice = parseFloat(product.price);
            const quantity = parseInt(item.quantity);
            if (isNaN(itemPrice) || isNaN(quantity) || quantity <= 0) {
                return res.status(400).json({ error: `Cantidad o precio inválido para el producto ID ${item.product_id}.` });
            }
            totalAmount += itemPrice * quantity;
            orderItemsData.push({ product_id: item.product_id, quantity, price_at_purchase: itemPrice });
        }

        const orders = await getSheetData('orders');
        const ordersAsObjects = rowsToObjects(orders);
        const newOrderId = ordersAsObjects.length > 0 ? Math.max(...ordersAsObjects.map(o => parseInt(o.id) || 0)) + 1 : 1;

        const newOrderData = [
            newOrderId,
            user_id,
            totalAmount,
            'completed', // O 'pending_payment' si tuvieras integración de pago real
            `PAYMENT_ID_${Date.now()}`, // Placeholder para el ID de pago
            new Date().toISOString()
        ];
        await appendRow('orders', newOrderData);

        // Añadir items del pedido a la hoja 'order_items'
        const existingOrderItems = await getSheetData('order_items');
        let currentOrderItemMaxId = existingOrderItems.length > 0 ? Math.max(...rowsToObjects(existingOrderItems).map(oi => parseInt(oi.id) || 0)) : 0;

        for (const item of orderItemsData) {
            currentOrderItemMaxId++;
            await appendRow('order_items', [
                currentOrderItemMaxId,
                newOrderId,
                item.product_id,
                item.quantity,
                item.price_at_purchase,
                new Date().toISOString()
            ]);
        }

        res.status(201).json({ message: 'Pedido realizado con éxito', order: { id: newOrderId, totalAmount } });
    } catch (error) {
        console.error('Error al realizar pedido:', error);
        res.status(500).json({ error: 'Error interno del servidor al realizar el pedido.' });
    }
});

// Obtener pedidos (clientes solo los suyos, administradores todos o por usuario)
app.get('/api/orders', authenticateToken, async (req, res) => {
    try {
        const orders = await getSheetData('orders');
        let ordersAsObjects = rowsToObjects(orders);

        if (req.user.role === 'client') {
            ordersAsObjects = ordersAsObjects.filter(o => String(o.user_id) === String(req.user.id));
        } else if (req.user.role === 'admin' && req.query.user_id) {
            ordersAsObjects = ordersAsObjects.filter(o => String(o.user_id) === String(req.query.user_id));
        }

        // Opcional: Adjuntar items de pedido a cada pedido
        const orderItems = rowsToObjects(await getSheetData('order_items'));
        ordersAsObjects = ordersAsObjects.map(order => {
            order.items = orderItems.filter(item => String(item.order_id) === String(order.id));
            return order;
        });

        res.json(ordersAsObjects);
    } catch (error) {
        console.error('Error al obtener pedidos:', error);
        res.status(500).json({ error: 'Error interno del servidor al obtener pedidos.' });
    }
});

app.get('/api/orders/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const orders = await getSheetData('orders');
        const order = rowsToObjects(orders).find(o => String(o.id) === String(id));

        if (!order) {
            return res.status(404).json({ error: 'Pedido no encontrado.' });
        }

        if (req.user.role === 'client' && String(order.user_id) !== String(req.user.id)) {
            return res.status(403).json({ error: 'No tienes permiso para ver este pedido.' });
        }

        // Obtener y adjuntar los items del pedido
        const orderItems = rowsToObjects(await getSheetData('order_items'));
        order.items = orderItems.filter(item => String(item.order_id) === String(order.id));

        res.json(order);
    } catch (error) {
        console.error('Error al obtener pedido por ID:', error);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// Solo administradores pueden actualizar el estado de los pedidos o eliminarlos
app.put('/api/orders/:id', authenticateToken, authorizeRoles('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const { status, payment_id } = req.body;
        const updatedFields = { status, payment_id };

        Object.keys(updatedFields).forEach(key => updatedFields[key] === undefined && delete updatedFields[key]);

        await updateRowById('orders', id, updatedFields);
        res.json({ message: 'Pedido actualizado con éxito.' });
    } catch (error) {
        console.error('Error al actualizar pedido:', error);
        res.status(500).json({ error: error.message || 'Error interno del servidor al actualizar pedido.' });
    }
});

app.delete('/api/orders/:id', authenticateToken, authorizeRoles('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        // Opcional: Eliminar también los order_items asociados
        const orderItems = rowsToObjects(await getSheetData('order_items'));
        const itemsToDelete = orderItems.filter(item => String(item.order_id) === String(id));
        for (const item of itemsToDelete) {
            await deleteRowById('order_items', item.id);
        }

        await deleteRowById('orders', id);
        res.json({ message: 'Pedido y sus items asociados eliminados con éxito.' });
    } catch (error) {
        console.error('Error al eliminar pedido:', error);
        res.status(500).json({ error: error.message || 'Error interno del servidor al eliminar pedido.' });
    }
});


// Iniciar el servidor
app.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});