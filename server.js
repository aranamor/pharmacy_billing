// server.js
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const path = require('path');
const session = require('express-session');

const app = express();
app.use(cors());

// Body parser and session middleware
app.use(bodyParser.json({ limit: '10mb' }));
app.use(session({
    secret: 'a-very-secret-key-for-pharmacy-billing',
    resave: false, // Don't save session if unmodified
    saveUninitialized: false, // Don't create a session until something is stored
    cookie: { 
        httpOnly: true, // Prevents client-side JS from accessing the cookie
        secure: false, // Should be true in production with HTTPS
        sameSite: 'strict' // Helps prevent CSRF attacks
    }
}));

// Serve static files like images and css
app.use(express.static(path.join(__dirname)));

// Hardcoded credentials as requested
const USERNAME = 'gmtr004';
const PASSWORD = 'art123';

// --------- DB CONFIG: update these to match your environment ----------
const DB_CONFIG = {
    host: 'localhost',
    user: 'root',
    password: 'root',   // <--- set your MySQL root or DB user password
    database: 'pharmacy_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: '+05:30'
};
// --------------------------------------------------------------------

let pool;
async function initDb() {
    pool = mysql.createPool(DB_CONFIG);
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
}
initDb().catch(err => {
    console.error('DB init error:', err);
    process.exit(1);
});

// ---------- Helper to run queries ----------
async function query(sql, params = []) {
    const [rows] = await pool.execute(sql, params);
    return rows;
}

// ---------- LOGIN AND AUTHENTICATION ----------

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === USERNAME && password === PASSWORD) {
        req.session.loggedIn = true;
        res.json({ success: true, message: 'Login successful' });
    } else {
        res.status(401).json({ success: false, message: 'Invalid username or password' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.status(500).json({ message: 'Could not log out.' });
        }
        res.clearCookie('connect.sid');
        res.json({ success: true, message: 'Logged out successfully' });
    });
});

app.post('/api/logout-beacon', (req, res) => {
    if (req.session) {
        req.session.destroy();
    }
    res.sendStatus(204);
});

const checkAuth = (req, res, next) => {
    if (req.session && req.session.loggedIn) {
        next();
    } else {
        res.redirect('/');
    }
};

// ---------- PAGE ROUTES ----------
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/bill', checkAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'bill.html'));
});

app.use('/api', checkAuth);

// ---------- API ROUTES ----------
app.get('/api/current-ist-date', async (req, res) => {
   try {
    const [rows] = await pool.query("SELECT DATE_FORMAT(NOW(), '%Y-%m-%d') as today");
    res.json({ currentDate: rows[0].today });
} catch (err) {
    console.error('GET /api/current-ist-date error:', err);
    res.status(500).json({ error: 'Failed to fetch current date' });
}
});

app.get('/api/dashboard-stats', async (req, res) => {
    try {
        const today = 'CURDATE()';
        const [salesTodayResult] = await pool.query(`SELECT SUM(grand_total) as totalSales, COUNT(id) as billCount FROM bills WHERE DATE(bill_date) = ${today} AND status = 'Completed'`);
        const [inventoryStatsResult] = await pool.query(`SELECT COUNT(id) as totalItems FROM products`);
        const [settingsRows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'lowStockThreshold'");
        const lowStockThreshold = settingsRows.length > 0 ? Number(settingsRows[0].setting_value) : 10;
        const [lowStockResult] = await pool.query('SELECT COUNT(id) as lowStockCount FROM products WHERE quantity <= ?', [lowStockThreshold]);
        const [expiringResult] = await pool.query(`
            SELECT COUNT(id) as expiringCount 
            FROM products 
            WHERE expiry IS NOT NULL 
            AND STR_TO_DATE(CONCAT(expiry, '-01'), '%Y-%m-%d') BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 1 MONTH)
        `);
        const [recentTransactions] = await pool.query("SELECT * FROM bills WHERE status = 'Completed' ORDER BY id DESC LIMIT 5");
        res.json({
            todaySales: salesTodayResult[0].totalSales || 0,
            todayBillsCount: salesTodayResult[0].billCount || 0,
            totalItems: inventoryStatsResult[0].totalItems || 0,
            lowStockCount: lowStockResult[0].lowStockCount || 0,
            expiringCount: expiringResult[0].expiringCount || 0,
            recentTransactions: recentTransactions,
        });
    } catch (err) {
        console.error('GET /api/dashboard-stats error:', err);
        res.status(500).json({ error: 'Failed to fetch dashboard stats' });
    }
});

// ---------- PRODUCTS ----------
app.get('/api/products', async (req, res) => {
    try {
        const rows = await query('SELECT * FROM products ORDER BY name ASC');
        res.json(rows);
    } catch (err) {
        console.error('GET /api/products error:', err);
        res.status(500).json({ error: 'Failed to fetch products' });
    }
});

app.get('/api/products/:id', async (req, res) => {
    try {
        const [row] = await query('SELECT * FROM products WHERE id = ?', [Number(req.params.id)]);
        if (row) {
            res.json(row);
        } else {
            res.status(404).json({ error: 'Product not found' });
        }
    } catch (err) {
        console.error(`GET /api/products/${req.params.id} error:`, err);
        res.status(500).json({ error: 'Failed to fetch product' });
    }
});

app.post('/api/products', async (req, res) => {
    try {
        const { name, hsn, batch, quantity, packaging, mrp, saleRate, saleRateInclusive, expiry, cgst, sgst, purchase_rate } = req.body;
        const result = await query(
            `INSERT INTO products (name, hsn, batch, quantity, packaging, mrp, purchase_rate, sale_rate, sale_rate_inclusive, expiry, cgst, sgst) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, hsn, batch, parseFloat(quantity || 0), packaging, Number(mrp || 0), Number(purchase_rate || 0), Number(saleRate || 0), Number(saleRateInclusive || 0), expiry, Number(cgst || 0), Number(sgst || 0)]
        );
        res.json({ message: 'Product added', id: result.insertId });
    } catch (err) {
        console.error('POST /api/products', err);
        if (err.code === 'ER_DUP_ENTRY') {
            res.status(400).json({ error: 'Product with same name & batch already exists' });
        } else {
            res.status(500).json({ error: 'Failed to add product' });
        }
    }
});

app.put('/api/products/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        const updates = req.body;
        const fields = [];
        const params = [];
        for (const k of ['name','hsn','batch','quantity','packaging','mrp','purchase_rate','sale_rate', 'sale_rate_inclusive','expiry','cgst','sgst']) {
            if (updates[k] !== undefined) {
                fields.push(`${k} = ?`);
                params.push(updates[k]);
            }
        }
        if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });
        params.push(id);
        await query(`UPDATE products SET ${fields.join(', ')} WHERE id = ?`, params);
        res.json({ message: 'Product updated' });
    } catch (err) {
        console.error('PUT /api/products/:id', err);
        res.status(500).json({ error: 'Failed to update product' });
    }
});

app.delete('/api/products/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        await query('DELETE FROM products WHERE id = ?', [id]);
        res.json({ message: 'Product deleted' });
    } catch (err) {
        console.error('DELETE /api/products/:id', err);
        res.status(500).json({ error: 'Delete failed' });
    }
});


// ---------- STOCK ADJUSTMENTS (EXPIRY/RETURNS) ----------
app.post('/api/stock-adjustments', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { productId, quantity, reason, notes } = req.body;
        const adjustedQty = -Math.abs(parseFloat(quantity)); // Ensure it's a negative number for removal

        if (!productId || isNaN(adjustedQty) || adjustedQty === 0) {
            return res.status(400).json({ error: 'Invalid product or quantity for adjustment.' });
        }

        await conn.beginTransaction();

        // Log the adjustment
        await conn.query(
            'INSERT INTO stock_adjustments (product_id, quantity_adjusted, reason, notes) VALUES (?, ?, ?, ?)',
            [productId, adjustedQty, reason, notes]
        );

        // Update product quantity
        await conn.query(
            'UPDATE products SET quantity = GREATEST(0, quantity + ?) WHERE id = ?',
            [adjustedQty, productId]
        );

        await conn.commit();
        res.json({ message: 'Stock adjusted successfully.' });
    } catch (err) {
        await conn.rollback();
        console.error('POST /api/stock-adjustments error:', err);
        res.status(500).json({ error: 'Failed to adjust stock.' });
    } finally {
        conn.release();
    }
});


// ---------- CUSTOMERS ----------
app.get('/api/customers', async (req, res) => {
    try {
        const rows = await query('SELECT * FROM customers ORDER BY name ASC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch customers' });
    }
});

// Get customer purchase history
app.get('/api/customers/:id/history', async (req, res) => {
    try {
        const customerId = Number(req.params.id);
        // UPDATED: Query now gets unique products and their last purchase date.
        const rows = await query(`
            SELECT
                bi.product_name,
                MAX(DATE_FORMAT(b.bill_date, '%Y-%m-%d')) as last_purchase_date
            FROM bills b
            JOIN bill_items bi ON b.id = bi.bill_id
            WHERE b.customer_id = ? AND b.status = 'Completed'
            GROUP BY bi.product_name
            ORDER BY last_purchase_date DESC
            LIMIT 20
        `, [customerId]);
        res.json(rows);
    } catch (err) {
        console.error('GET /api/customers/:id/history error:', err);
        res.status(500).json({ error: "Failed to fetch customer's purchase history." });
    }
});


app.get('/api/customers/:id', async (req, res) => {
    try {
        const [row] = await query('SELECT * FROM customers WHERE id = ?', [Number(req.params.id)]);
        if (row) {
            res.json(row);
        } else {
            res.status(404).json({ error: 'Customer not found' });
        }
    } catch (err) {
        console.error(`GET /api/customers/${req.params.id} error:`, err);
        res.status(500).json({ error: 'Failed to fetch customer' });
    }
});

app.post('/api/customers', async (req, res) => {
    try {
        const { name, mobile, doctorName } = req.body;
        const [result] = await pool.query(
            `INSERT INTO customers (name, mobile, doctor_name) VALUES (?, ?, ?)`,
            [name, mobile, doctorName]
        );
        res.json({ message: 'Customer added', id: result.insertId });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            res.status(400).json({ error: 'Customer with same mobile number already exists' });
        } else {
            res.status(500).json({ error: 'Failed to add customer' });
        }
    }
});

app.put('/api/customers/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        const { name, mobile, doctor_name } = req.body;
        await query(
            `UPDATE customers SET name = ?, mobile = ?, doctor_name = ? WHERE id = ?`,
            [name, mobile, doctor_name, id]
        );
        res.json({ message: 'Customer updated successfully' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
             res.status(400).json({ error: 'Another customer with this mobile number already exists.' });
        } else {
             res.status(500).json({ error: 'Failed to update customer' });
        }
    }
});

app.delete('/api/customers/:id', async (req, res) => {
    try {
        await query('DELETE FROM customers WHERE id = ?', [Number(req.params.id)]);
        res.json({ message: 'Customer deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Delete failed' });
    }
});

// ---------- SUPPLIERS ----------
app.get('/api/suppliers', async (req, res) => {
    try {
        const rows = await query('SELECT * FROM suppliers ORDER BY name ASC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch suppliers' });
    }
});

// ---------- SETTINGS ----------
app.get('/api/settings', async (req, res) => {
    try {
        const rows = await query('SELECT * FROM settings');
        const obj = {};
        rows.forEach(r => obj[r.setting_key] = r.setting_value);
        if (obj.lowStockThreshold) obj.lowStockThreshold = Number(obj.lowStockThreshold);
        res.json(obj);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

app.post('/api/settings', async (req, res) => {
    try {
        const newSettings = req.body.settings || req.body;
        for (const key of Object.keys(newSettings)) {
            const value = String(newSettings[key]);
            await query(
                `INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?`,
                [key, value, value]
            );
        }
        res.json({ message: 'Settings saved' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

// ---------- BILLS (SALES) ----------
app.get('/api/bills', async (req, res) => {
    try {
        const rows = await query("SELECT * FROM bills WHERE status = 'Completed' ORDER BY id DESC");
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to list bills' });
    }
});

// Get Held Bills
app.get('/api/held-bills', async (req, res) => {
    try {
        const rows = await query("SELECT * FROM bills WHERE status = 'Held' ORDER BY id DESC");
        res.json(rows);
    } catch (err) {
        console.error('GET /api/held-bills error:', err);
        res.status(500).json({ error: 'Failed to fetch held bills' });
    }
});

app.get('/api/bills/:id', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const [bRows] = await conn.query('SELECT * FROM bills WHERE id = ?', [Number(req.params.id)]);
        if (!bRows || bRows.length === 0) {
            conn.release();
            return res.status(404).json({ error: 'Bill not found' });
        }
        const [items] = await conn.query('SELECT bi.*, p.name as product_name FROM bill_items bi LEFT JOIN products p ON bi.product_id = p.id WHERE bi.bill_id = ?', [Number(req.params.id)]);
        conn.release();
        res.json({ ...bRows[0], items });
    } catch (err) {
        conn.release();
        res.status(500).json({ error: 'Failed to fetch bill' });
    }
});

app.post('/api/bills', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        // UPDATED: Changed to snake_case to match frontend
        const { patient_name, patient_mobile, doctor_name, items, bill_date, overall_discount_percent, status = 'Completed' } = req.body;
        
        let customerId = null;
        if (patient_mobile) {
            const [existing] = await conn.query('SELECT id FROM customers WHERE mobile = ? LIMIT 1', [patient_mobile]);
            if (existing.length > 0) {
                customerId = existing[0].id;
                // Optionally update customer name if it has changed
                await conn.query('UPDATE customers SET name = ?, doctor_name = ? WHERE id = ?', [patient_name, doctor_name, customerId]);
            } else {
                const [newCustomer] = await conn.query('INSERT INTO customers (name, mobile, doctor_name) VALUES (?, ?, ?)', [patient_name, patient_mobile, doctor_name]);
                customerId = newCustomer.insertId;
            }
        }
        
        let subtotal = 0, totalDiscount = 0, totalCGST = 0, totalSGST = 0;
        const overallDiscount = Number(overall_discount_percent) || 0;
        for (const it of items) {
            const itemSubtotal = (Number(it.rate) || 0) * (Number(it.quantity) || 0);
            const itemDiscountAmount = itemSubtotal * ((Number(it.discount) || 0) / 100);
            const taxableAfterItemDisc = itemSubtotal - itemDiscountAmount;
            const overallDiscountAmount = taxableAfterItemDisc * (overallDiscount / 100);
            const finalTaxable = taxableAfterItemDisc - overallDiscountAmount;
            subtotal += itemSubtotal;
            totalDiscount += itemDiscountAmount + overallDiscountAmount;
            totalCGST += finalTaxable * ((Number(it.cgst) || 0) / 100);
            totalSGST += finalTaxable * ((Number(it.sgst) || 0) / 100);
        }
        const grandTotal = subtotal - totalDiscount + totalCGST + totalSGST;
        await conn.beginTransaction();

        const [billInsert] = await conn.query(
            `INSERT INTO bills (bill_number, patient_name, patient_mobile, doctor_name, subtotal, total_discount, total_cgst, total_sgst, grand_total, customer_id, bill_date, overall_discount_percent, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ['TEMP', patient_name, patient_mobile, doctor_name, subtotal, totalDiscount, totalCGST, totalSGST, grandTotal, customerId, bill_date || new Date(), overallDiscount, status]
        );
        const billId = billInsert.insertId;
        const year = new Date().getFullYear();
        const billNumber = `INV-${year}-${String(billId).padStart(4, '0')}`;

        await conn.query('UPDATE bills SET bill_number = ? WHERE id = ?', [billNumber, billId]);
        
        for (const it of items) {
            await conn.query(
                `INSERT INTO bill_items (bill_id, product_id, product_name, batch, mrp, rate, quantity, expiry, discount, cgst, sgst) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                 [billId, it.id, it.name, it.batch, it.mrp, it.rate, parseFloat(it.quantity), it.expiry, it.discount, it.cgst, it.sgst]
            );
            // Only adjust stock for completed bills
            if (it.id && status === 'Completed') {
                await conn.query(`UPDATE products SET quantity = GREATEST(0, quantity - ?) WHERE id = ?`, [parseFloat(it.quantity), it.id]);
            }
        }
        await conn.commit();
        conn.release();
        res.json({ message: `Bill ${status === 'Held' ? 'held' : 'created'}`, id: billId, bill_number: billNumber });
    } catch (err) {
        await conn.rollback().catch(() => {});
        conn.release();
        console.error('POST /api/bills', err);
        res.status(500).json({ error: 'Failed to create bill' });
    }
});

app.put('/api/bills/:id', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const billId = Number(req.params.id);
        const { items, patient_name, patient_mobile, doctor_name, overall_discount_percent, status = 'Completed' } = req.body;
        
        const [existingBill] = await conn.query('SELECT * FROM bills WHERE id = ?', [billId]);
        if (!existingBill.length) {
            return res.status(404).json({ error: 'Bill not found.' });
        }
        const wasHeld = existingBill[0].status === 'Held';

        const [existingItems] = await conn.query('SELECT * FROM bill_items WHERE bill_id = ?', [billId]);
        
        const overallDiscount = Number(overall_discount_percent) || 0;
        let subtotal = 0, totalDiscount = 0, totalCGST = 0, totalSGST = 0;
        for (const it of items) {
            const itemSubtotal = (Number(it.rate) || 0) * (Number(it.quantity) || 0);
            const itemDiscountAmount = itemSubtotal * ((Number(it.discount) || 0) / 100);
            const taxableAfterItemDisc = itemSubtotal - itemDiscountAmount;
            const overallDiscountAmount = taxableAfterItemDisc * (overallDiscount / 100);
            const finalTaxable = taxableAfterItemDisc - overallDiscountAmount;
            subtotal += itemSubtotal;
            totalDiscount += itemDiscountAmount + overallDiscountAmount;
            totalCGST += finalTaxable * ((Number(it.cgst) || 0) / 100);
            totalSGST += finalTaxable * ((Number(it.sgst) || 0) / 100);
        }
        const grandTotal = subtotal - totalDiscount + totalCGST + totalSGST;
        await conn.beginTransaction();
        
        // Stock adjustment logic
        if (status === 'Completed') {
            const existingMap = {};
            if (!wasHeld) { // Only revert stock if it was previously completed
                for (const it of existingItems) {
                    if(it.product_id) existingMap[it.product_id] = (existingMap[it.product_id] || 0) + it.quantity;
                }
            }
            const newMap = {};
            for (const it of items) {
                 if(it.product_id || it.id) newMap[it.product_id || it.id] = (newMap[it.product_id || it.id] || 0) + parseFloat(it.quantity);
            }
            for (const k of new Set([...Object.keys(existingMap), ...Object.keys(newMap)])) {
                const delta = (existingMap[k] || 0) - (newMap[k] || 0);
                if (delta !== 0) {
                     await conn.query('UPDATE products SET quantity = GREATEST(0, quantity + ?) WHERE id = ?', [delta, Number(k)]);
                }
            }
        }

        await conn.query('DELETE FROM bill_items WHERE bill_id = ?', [billId]);
        for (const it of items) {
            await conn.query(
                `INSERT INTO bill_items (bill_id, product_id, product_name, batch, mrp, rate, quantity, expiry, discount, cgst, sgst) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                 [billId, it.product_id || it.id, it.product_name || it.name, it.batch, it.mrp, it.rate, parseFloat(it.quantity), it.expiry, it.discount, it.cgst, it.sgst]
            );
        }
        await conn.query(
            `UPDATE bills SET patient_name = ?, patient_mobile = ?, doctor_name = ?, subtotal = ?, total_discount = ?, total_cgst = ?, total_sgst = ?, grand_total = ?, overall_discount_percent = ?, status = ? WHERE id = ?`,
            [patient_name, patient_mobile, doctor_name, subtotal, totalDiscount, totalCGST, totalSGST, grandTotal, overallDiscount, status, billId]
        );
        await conn.commit();
        conn.release();
        res.json({ message: 'Bill updated', id: billId });
    } catch (err) {
        await conn.rollback().catch(()=>{});
        conn.release();
        console.error('PUT /api/bills/:id', err);
        res.status(500).json({ error: 'Failed to update bill' });
    }
});

// ADDED: New endpoint to delete bills
app.delete('/api/bills/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        // We only expect to delete 'Held' bills this way. 
        // Completed bills should probably be cancelled/returned, not deleted.
        await query("DELETE FROM bills WHERE id = ? AND status = 'Held'", [id]);
        res.json({ message: 'Held bill deleted' });
    } catch (err) {
        console.error('DELETE /api/bills/:id', err);
        res.status(500).json({ error: 'Failed to delete held bill' });
    }
});


// ---------- PURCHASES ----------
app.get('/api/purchases', async (req, res) => {
    try {
        const rows = await query('SELECT id, bill_number, supplier_name, bill_date, tax_type, grand_total FROM purchase_bills ORDER BY bill_date DESC, id DESC');
        res.json(rows);
    } catch (err) {
        console.error('GET /api/purchases error:', err);
        res.status(500).json({ error: 'Failed to fetch purchase bills' });
    }
});

app.get('/api/purchases/:id', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const [pRows] = await conn.query('SELECT * FROM purchase_bills WHERE id = ?', [Number(req.params.id)]);
        if (!pRows || pRows.length === 0) {
            conn.release();
            return res.status(404).json({ error: 'Purchase Bill not found' });
        }
        const [items] = await conn.query('SELECT * FROM purchase_bill_items WHERE purchase_bill_id = ?', [Number(req.params.id)]);
        conn.release();
        res.json({ ...pRows[0], items });
    } catch (err) {
        conn.release();
        console.error('GET /api/purchases/:id', err);
        res.status(500).json({ error: 'Failed to fetch purchase bill' });
    }
});

app.post('/api/purchases', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { supplierName, billNumber, billDate, taxType, items, overallDiscountPercent } = req.body;

        if (!supplierName || !billNumber || !billDate || !taxType || !items || items.length === 0) {
            conn.release();
            return res.status(400).json({ error: 'Missing required fields for purchase bill.' });
        }
        
        // Find or create supplier
        let supplierId;
        const [existingSupplier] = await conn.query('SELECT id FROM suppliers WHERE name = ?', [supplierName]);
        if (existingSupplier.length > 0) {
            supplierId = existingSupplier[0].id;
        } else {
            const [newSupplier] = await conn.query('INSERT INTO suppliers (name) VALUES (?)', [supplierName]);
            supplierId = newSupplier.insertId;
        }

        const overallDiscount = Number(overallDiscountPercent) || 0;

        let totalPreTax = 0;
        let totalGstAmount = 0;

        items.forEach(item => {
            const base = (Number(item.purchaseRate) || 0) * (parseFloat(item.quantity) || 0);
            const itemDiscounted = base * (1 - ((Number(item.discount) || 0) / 100));
            totalPreTax += itemDiscounted;
        });

        const overallDiscountAmount = totalPreTax * (overallDiscount / 100);
        const taxableAmount = totalPreTax - overallDiscountAmount;

        items.forEach(item => {
            const base = (Number(item.purchaseRate) || 0) * (parseFloat(item.quantity) || 0);
            const itemDiscounted = base * (1 - ((Number(item.discount) || 0) / 100));
            const finalDiscounted = itemDiscounted * (1 - (overallDiscount / 100));
            const totalGstPercent = (Number(item.igst) || 0) > 0 ? (Number(item.igst) || 0) : ((Number(item.cgst) || 0) + (Number(item.sgst) || 0));
            totalGstAmount += finalDiscounted * (totalGstPercent / 100);
        });
        
        const totalBeforeRounding = taxableAmount + totalGstAmount;
        const grandTotal = Math.round(totalBeforeRounding);
        const rounding = grandTotal - totalBeforeRounding;

        await conn.beginTransaction();

        const [purchaseInsert] = await conn.query(
            `INSERT INTO purchase_bills (supplier_id, supplier_name, bill_number, bill_date, tax_type, total_pre_tax, overall_discount_percent, overall_discount_amount, taxable_amount, total_gst_amount, rounding, grand_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [supplierId, supplierName, billNumber, billDate, taxType, totalPreTax, overallDiscount, overallDiscountAmount, taxableAmount, totalGstAmount, rounding, grandTotal]
        );
        const purchaseBillId = purchaseInsert.insertId;

        for (const item of items) {
            const { 
                productName, hsn, batch, packaging, quantity, freeQuantity, 
                mrp, purchaseRate, saleRate, saleRateIncl, discount, expiry, 
                cgst, sgst, igst, saleCgst, saleSgst
            } = item;
            
            const baseAmount = (Number(purchaseRate) || 0) * (parseFloat(quantity) || 0);
            const discountAmount = baseAmount * ((Number(discount) || 0) / 100);
            const taxableAmountForItem = baseAmount - discountAmount;
            const totalGstPercent = (Number(igst) || 0) > 0 ? (Number(igst) || 0) : ((Number(cgst) || 0) + (Number(sgst) || 0));
            const gstAmountForItem = taxableAmountForItem * (totalGstPercent / 100);
            const itemTotalAmount = taxableAmountForItem + gstAmountForItem;
            
            await conn.query(
                `INSERT INTO purchase_bill_items (purchase_bill_id, product_name, hsn, batch, packaging, quantity, free_quantity, mrp, purchase_rate, sale_rate, sale_rate_inclusive, discount, expiry, cgst, sgst, igst, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [purchaseBillId, productName, hsn, batch, packaging, parseFloat(quantity), parseFloat(freeQuantity || 0), mrp, purchaseRate, saleRate, saleRateIncl, discount, expiry, cgst, sgst, igst, itemTotalAmount]
            );
            
            const totalQuantity = (parseFloat(quantity) || 0) + (parseFloat(freeQuantity) || 0);

            await conn.query(
                `INSERT INTO products (name, hsn, batch, packaging, quantity, mrp, purchase_rate, sale_rate, sale_rate_inclusive, expiry, cgst, sgst) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE 
                    quantity = quantity + VALUES(quantity), 
                    packaging = VALUES(packaging), 
                    mrp = VALUES(mrp), 
                    purchase_rate = VALUES(purchase_rate),
                    sale_rate = VALUES(sale_rate),
                    sale_rate_inclusive = VALUES(sale_rate_inclusive), 
                    expiry = VALUES(expiry), 
                    cgst = VALUES(cgst), 
                    sgst = VALUES(sgst)`,
                [productName, hsn, batch, packaging, totalQuantity, mrp, purchaseRate, saleRate, saleRateIncl, expiry, saleCgst, saleSgst]
            );
        }

        await conn.commit();
        conn.release();
        res.json({ message: 'Purchase bill added and inventory updated successfully!', id: purchaseBillId });

    } catch (err) {
        await conn.rollback().catch(() => {});
        conn.release();
        console.error('POST /api/purchases error:', err);
        res.status(500).json({ error: 'Failed to create purchase bill and update inventory.' });
    }
});


// ---------- REPORTS ----------
app.get('/api/reports', async (req, res) => {
    const { type, fromDate, toDate } = req.query;
    if (!type || !fromDate || !toDate) {
        return res.status(400).json({ error: 'Report type and date range are required.' });
    }
    
    try {
        let reportData = [];
        let queryStr = '';

        switch(type) {
            case 'sales':
                queryStr = `SELECT bill_number, DATE_FORMAT(bill_date, '%Y-%m-%d') as date, patient_name, grand_total FROM bills WHERE status = 'Completed' AND DATE(bill_date) BETWEEN ? AND ? ORDER BY bill_date DESC`;
                reportData = await query(queryStr, [fromDate, toDate]);
                break;
            case 'gst':
                queryStr = `SELECT bill_number, DATE_FORMAT(bill_date, '%Y-%m-%d') as date, subtotal, total_discount, (subtotal - total_discount) as taxable_value, total_cgst, total_sgst, grand_total FROM bills WHERE status = 'Completed' AND DATE(bill_date) BETWEEN ? AND ? ORDER BY bill_date DESC`;
                reportData = await query(queryStr, [fromDate, toDate]);
                break;
            case 'inventory':
                queryStr = `SELECT name, packaging, hsn, batch, quantity, mrp, purchase_rate, sale_rate_inclusive, expiry FROM products ORDER BY name`;
                reportData = await query(queryStr);
                break;
            case 'purchases':
                queryStr = `SELECT bill_number, supplier_name, DATE_FORMAT(bill_date, '%Y-%m-%d') as date, tax_type, grand_total FROM purchase_bills WHERE bill_date BETWEEN ? AND ? ORDER BY bill_date DESC`;
                reportData = await query(queryStr, [fromDate, toDate]);
                break;
            case 'supplier_purchases':
                queryStr = `SELECT s.name as supplier_name, pb.bill_number, DATE_FORMAT(pb.bill_date, '%Y-%m-%d') as date, pbi.product_name, pbi.quantity, pbi.purchase_rate, pbi.amount FROM purchase_bill_items pbi JOIN purchase_bills pb ON pbi.purchase_bill_id = pb.id JOIN suppliers s ON pb.supplier_id = s.id WHERE pb.bill_date BETWEEN ? AND ? ORDER BY s.name, pb.bill_date`;
                reportData = await query(queryStr, [fromDate, toDate]);
                break;
            case 'expiry':
                 queryStr = `SELECT name, batch, quantity, expiry FROM products WHERE expiry IS NOT NULL AND STR_TO_DATE(CONCAT(expiry, '-01'), '%Y-%m-%d') < CURDATE() ORDER BY expiry`;
                 reportData = await query(queryStr);
                 break;
            case 'profitability':
                queryStr = `
                    SELECT
                        bi.product_name,
                        p.batch,
                        p.purchase_rate,
                        SUM(bi.quantity) AS total_quantity_sold,
                        AVG(bi.rate) AS avg_sale_rate,
                        SUM(bi.quantity * (bi.rate - p.purchase_rate)) AS estimated_gross_profit
                    FROM bill_items bi
                    JOIN products p ON bi.product_id = p.id
                    JOIN bills b ON bi.bill_id = b.id
                    WHERE b.status = 'Completed' AND DATE(b.bill_date) BETWEEN ? AND ?
                    GROUP BY bi.product_name, p.batch, p.purchase_rate
                    ORDER BY estimated_gross_profit DESC
                `;
                reportData = await query(queryStr, [fromDate, toDate]);
                break;
            case 'movement':
                queryStr = `
                    SELECT
                        bi.product_name,
                        p.batch,
                        SUM(bi.quantity) as total_quantity_sold,
                        COUNT(DISTINCT b.id) as num_bills
                    FROM bill_items bi
                    JOIN bills b ON bi.bill_id = b.id
                    LEFT JOIN products p ON bi.product_id = p.id
                    WHERE b.status = 'Completed' AND DATE(b.bill_date) BETWEEN ? AND ?
                    GROUP BY bi.product_name, p.batch
                    ORDER BY total_quantity_sold DESC
                `;
                reportData = await query(queryStr, [fromDate, toDate]);
                break;
            case 'hsn_sale':
                queryStr = `
                    SELECT
                        p.hsn AS 'hsn_code',
                        p.packaging,
                        SUM(bi.quantity) AS 'quantity',
                        (bi.cgst + bi.sgst) AS 'gst_percent',
                        SUM(bi.rate * bi.quantity * (1 - bi.discount / 100)) AS 'taxable_amount',
                        SUM((bi.rate * bi.quantity * (1 - bi.discount / 100)) * (bi.cgst / 100)) AS 'cgst_amount',
                        SUM((bi.rate * bi.quantity * (1 - bi.discount / 100)) * (bi.sgst / 100)) AS 'sgst_amount',
                        SUM((bi.rate * bi.quantity * (1 - bi.discount / 100)) * (1 + (bi.cgst + bi.sgst) / 100)) AS 'total_amount'
                    FROM
                        bill_items bi
                    JOIN
                        bills b ON bi.bill_id = b.id
                    LEFT JOIN
                        products p ON bi.product_id = p.id
                    WHERE b.status = 'Completed' AND
                        DATE(b.bill_date) BETWEEN ? AND ?
                    GROUP BY
                        p.hsn, p.packaging, bi.cgst, bi.sgst
                    ORDER BY
                        p.hsn;
                `;
                reportData = await query(queryStr, [fromDate, toDate]);
                break;
            default:
                return res.status(400).json({ error: 'Invalid report type' });
        }
        res.json(reportData);
    } catch (err) {
        console.error(`Error generating ${type} report:`, err);
        res.status(500).json({ error: `Failed to generate ${type} report`});
    }
});


// ---------- Start Server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`API server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser`);
});

