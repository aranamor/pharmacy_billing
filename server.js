// server.js
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
const path = require('path');

// Serve bill.html and any other static files from current folder
app.use(express.static(path.join(__dirname)));

// Default route: send bill.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'bill.html'));
});

app.use(bodyParser.json({ limit: '10mb' }));

// --------- DB CONFIG: update these to match your environment ----------
const DB_CONFIG = {
    host: 'localhost',
    user: 'root',
    password: 'root',   // <--- set your MySQL root or DB user password
    database: 'pharmacy_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};
// --------------------------------------------------------------------

let pool;
async function initDb() {
    pool = mysql.createPool(DB_CONFIG);
    // optional quick check
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

// ---------- PRODUCTS ----------
app.get('/api/products', async (req, res) => {
    try {
        const rows = await query('SELECT * FROM products ORDER BY id DESC');
        // Normalize field names to align with front-end usage
        const products = rows.map(r => ({
            id: r.id,
            name: r.name,
            hsn: r.hsn,
            batch: r.batch,
            quantity: r.quantity,
            mrp: Number(r.mrp),
            sale_rate: Number(r.sale_rate || r.sale_rate), // if your schema uses sale_rate
            expiry: r.expiry || null, // No need for date conversion, it's already a string
            cgst: Number(r.cgst),
            sgst: Number(r.sgst)
        }));
        res.json(products);
    } catch (err) {
        console.error('GET /api/products error:', err);
        res.status(500).json({ error: 'Failed to fetch products' });
    }
});

app.get('/api/products/search', async (req, res) => {
    try {
        const q = (req.query.query || '').trim();
        if (!q) {
            const rows = await query('SELECT * FROM products ORDER BY id DESC LIMIT 50');
            return res.json(rows);
        }
        const like = `%${q}%`;
        const rows = await query(
            `SELECT * FROM products WHERE name LIKE ? OR batch LIKE ? OR hsn LIKE ? ORDER BY id DESC LIMIT 50`,
            [like, like, like]
        );
        res.json(rows);
    } catch (err) {
        console.error('GET /api/products/search error:', err);
        res.status(500).json({ error: 'Search failed' });
    }
});

app.get('/api/products/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        const rows = await query('SELECT * FROM products WHERE id = ? LIMIT 1', [id]);
        if (!rows || rows.length === 0) return res.status(404).json({ error: 'Product not found' });
        res.json(rows[0]);
    } catch (err) {
        console.error('GET /api/products/:id', err);
        res.status(500).json({ error: 'Failed to fetch product' });
    }
});

app.post('/api/products', async (req, res) => {
    try {
        const { name, hsn, batch, quantity, mrp, saleRate, sale_rate, expiry, cgst, sgst } = req.body;
        const saleRateToUse = saleRate !== undefined ? saleRate : sale_rate;
        const result = await query(
            `INSERT INTO products (name, hsn, batch, quantity, mrp, sale_rate, expiry, cgst, sgst) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, hsn, batch, Number(quantity || 0), Number(mrp || 0), Number(saleRateToUse || 0), expiry, Number(cgst || 0), Number(sgst || 0)]
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
        for (const k of ['name','hsn','batch','quantity','mrp','sale_rate','expiry','cgst','sgst']) {
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

// ---------- CUSTOMERS ----------
app.get('/api/customers', async (req, res) => {
    try {
        const rows = await query('SELECT * FROM customers ORDER BY name ASC');
        res.json(rows);
    } catch (err) {
        console.error('GET /api/customers error:', err);
        res.status(500).json({ error: 'Failed to fetch customers' });
    }
});

app.get('/api/customers/search', async (req, res) => {
    try {
        const q = (req.query.query || '').trim();
        if (!q) {
            const rows = await query('SELECT * FROM customers ORDER BY name ASC LIMIT 50');
            return res.json(rows);
        }
        const like = `%${q}%`;
        const rows = await query(
            `SELECT * FROM customers WHERE name LIKE ? OR mobile LIKE ? ORDER BY name ASC LIMIT 50`,
            [like, like]
        );
        res.json(rows);
    } catch (err) {
        console.error('GET /api/customers/search error:', err);
        res.status(500).json({ error: 'Search failed' });
    }
});

// Endpoint to add a new customer (used by the billing process)
app.post('/api/customers', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { name, mobile, doctorName } = req.body;
        // Check for existing customer to prevent duplicates
        const [existing] = await conn.query('SELECT id FROM customers WHERE mobile = ? LIMIT 1', [mobile]);
        if (existing.length > 0) {
            conn.release();
            return res.json({ message: 'Customer already exists', id: existing[0].id });
        }
        
        const [result] = await conn.query(
            `INSERT INTO customers (name, mobile, doctor_name) VALUES (?, ?, ?)`,
            [name, mobile, doctorName]
        );
        conn.release();
        res.json({ message: 'Customer added', id: result.insertId });
    } catch (err) {
        conn.release();
        console.error('POST /api/customers', err);
        if (err.code === 'ER_DUP_ENTRY') {
            res.status(400).json({ error: 'Customer with same mobile number already exists' });
        } else {
            res.status(500).json({ error: 'Failed to add customer' });
        }
    }
});

app.get('/api/customers/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        const rows = await query('SELECT * FROM customers WHERE id = ? LIMIT 1', [id]);
        if (!rows || rows.length === 0) return res.status(404).json({ error: 'Customer not found' });
        res.json(rows[0]);
    } catch (err) {
        console.error('GET /api/customers/:id', err);
        res.status(500).json({ error: 'Failed to fetch customer' });
    }
});

app.put('/api/customers/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        const { name, mobile, doctor_name } = req.body;
        
        if (!name || !mobile) {
            return res.status(400).json({ error: 'Name and mobile are required.' });
        }

        const result = await query(
            `UPDATE customers SET name = ?, mobile = ?, doctor_name = ? WHERE id = ?`,
            [name, mobile, doctor_name, id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }
        res.json({ message: 'Customer updated successfully' });
    } catch (err) {
        console.error('PUT /api/customers/:id', err);
        if (err.code === 'ER_DUP_ENTRY') {
             res.status(400).json({ error: 'Another customer with this mobile number already exists.' });
        } else {
             res.status(500).json({ error: 'Failed to update customer' });
        }
    }
});

// Endpoint to delete a customer
app.delete('/api/customers/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        const result = await query('DELETE FROM customers WHERE id = ?', [id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }
        res.json({ message: 'Customer deleted' });
    } catch (err) {
        console.error('DELETE /api/customers/:id', err);
        res.status(500).json({ error: 'Delete failed' });
    }
});

// ---------- SETTINGS ----------
app.get('/api/settings', async (req, res) => {
    try {
        const rows = await query('SELECT * FROM settings');
        const obj = {};
        rows.forEach(r => obj[r.setting_key] = r.setting_value);
        // Normalize numeric lowStockThreshold
        if (obj.lowStockThreshold) obj.lowStockThreshold = Number(obj.lowStockThreshold);
        res.json(obj);
    } catch (err) {
        console.error('GET /api/settings', err);
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

app.post('/api/settings', async (req, res) => {
    try {
        const newSettings = req.body.settings || req.body;
        // upsert settings keys
        const keys = Object.keys(newSettings);
        for (const key of keys) {
            const value = String(newSettings[key]);
            await query(
                `INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?`,
                [key, value, value]
            );
        }
        res.json({ message: 'Settings saved' });
    } catch (err) {
        console.error('POST /api/settings', err);
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

// ---------- BILLS ----------
// List bills
app.get('/api/bills', async (req, res) => {
    try {
        const rows = await query('SELECT * FROM bills ORDER BY id DESC');
        // Provide fields in structure front-end expects
        const bills = rows.map(b => ({
            id: b.id,
            bill_number: b.bill_number,
            bill_date: b.bill_date,
            patient_name: b.patient_name,
            patient_mobile: b.patient_mobile,
            doctor_name: b.doctor_name,
            subtotal: Number(b.subtotal),
            total_discount: Number(b.total_discount),
            total_cgst: Number(b.total_cgst),
            total_sgst: Number(b.total_sgst),
            grand_total: Number(b.grand_total)
        }));
        res.json(bills);
    } catch (err) {
        console.error('GET /api/bills', err);
        res.status(500).json({ error: 'Failed to list bills' });
    }
});

// Get single bill with items
app.get('/api/bills/:id', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const billId = Number(req.params.id);
        const [bRows] = await conn.query('SELECT * FROM bills WHERE id = ?', [billId]);
        if (!bRows || bRows.length === 0) {
            conn.release();
            return res.status(404).json({ error: 'Bill not found' });
        }
        const bill = bRows[0];
        const [items] = await conn.query('SELECT * FROM bill_items WHERE bill_id = ?', [billId]);
        
        // Map items to expected front-end shape with proper MRP and Expiry handling
        const mappedItems = items.map(it => ({
            id: it.id,
            bill_id: it.bill_id,
            product_id: it.product_id,
            product_name: it.product_name,
            batch: it.batch || '',
            mrp: it.mrp ? Number(it.mrp) : 0,  // Ensure MRP is properly converted
            rate: Number(it.rate || 0),
            quantity: Number(it.quantity || 0),
            expiry: it.expiry || null,  // Expiry is now a string, no conversion needed
            discount: Number(it.discount || 0),
            cgst: Number(it.cgst || 0),
            sgst: Number(it.sgst || 0)
        }));
        
        conn.release();
        res.json({
            id: bill.id,
            bill_number: bill.bill_number,
            bill_date: bill.bill_date,
            patient_name: bill.patient_name,
            patient_mobile: bill.patient_mobile,
            doctor_name: bill.doctor_name,
            subtotal: Number(bill.subtotal),
            total_discount: Number(bill.total_discount),
            total_cgst: Number(bill.total_cgst),
            total_sgst: Number(bill.total_sgst),
            grand_total: Number(bill.grand_total),
            items: mappedItems
        });
    } catch (err) {
        conn.release();
        console.error('GET /api/bills/:id', err);
        res.status(500).json({ error: 'Failed to fetch bill' });
    }
});

// Create new bill
app.post('/api/bills', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const body = req.body;
        // Accept either camelCase or snake_case
        const billNumber = body.billNumber || body.bill_number || `BILL-${Date.now()}`;
        const billDate = body.bill_date || body.billDate || new Date();
        const patientName = body.patientName || body.patient_name;
        const patientMobile = body.patientMobile || body.patient_mobile;
        const doctorName = body.doctorName || body.doctor_name || null;
        const items = body.items || [];

        // --- NEW: Customer handling logic ---
        let customerId = null;
        if (patientMobile) {
            const [existingCustomer] = await conn.query('SELECT id FROM customers WHERE mobile = ? LIMIT 1', [patientMobile]);
            if (existingCustomer.length > 0) {
                customerId = existingCustomer[0].id;
            } else {
                const [newCustomer] = await conn.query(
                    `INSERT INTO customers (name, mobile, doctor_name) VALUES (?, ?, ?)`,
                    [patientName, patientMobile, doctorName]
                );
                customerId = newCustomer.insertId;
            }
        }
        // --- END NEW: Customer handling logic ---

        // Recalculate server-side to ensure correctness
        let subtotal = 0, totalDiscount = 0, totalCGST = 0, totalSGST = 0;
        for (const it of items) {
            const rate = Number(it.rate || it.sale_rate || 0);
            const qty = Number(it.quantity || 0);
            const discount = Number(it.discount || 0);
            const cgst = Number(it.cgst || 0);
            const sgst = Number(it.sgst || 0);

            const itemSubtotal = rate * qty;
            const itemDiscount = itemSubtotal * (discount / 100);
            const taxable = itemSubtotal - itemDiscount;
            subtotal += itemSubtotal;
            totalDiscount += itemDiscount;
            totalCGST += taxable * (cgst / 100);
            totalSGST += taxable * (sgst / 100);
        }
        const grandTotal = subtotal - totalDiscount + totalCGST + totalSGST;

        await conn.beginTransaction();

        const [billInsert] = await conn.query(
            `INSERT INTO bills (bill_number, bill_date, patient_name, patient_mobile, doctor_name, subtotal, total_discount, total_cgst, total_sgst, grand_total, customer_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
             [billNumber, billDate, patientName, patientMobile, doctorName, subtotal, totalDiscount, totalCGST, totalSGST, grandTotal, customerId]
        );
        const billId = billInsert.insertId;

        // Insert each bill item and reduce product stock
        for (const it of items) {
            // Try multiple possible field names for product ID
            const productId = it.product_id || it.productId || it.id || null;
            const productName = it.product_name || it.productName || it.name || '';
            const batch = it.batch || '';
            const rate = Number(it.rate || 0);
            const qty = Number(it.quantity || 0);
            const discount = Number(it.discount || 0);
            const cgst = Number(it.cgst || 0);
            const sgst = Number(it.sgst || 0);
            
            // Get MRP and Expiry from the item sent by the frontend
            const mrp = Number(it.mrp || 0);
            const expiry = it.expiry || null;
            
            await conn.query(
                `INSERT INTO bill_items (bill_id, product_id, product_name, batch, mrp, rate, quantity, expiry, discount, cgst, sgst)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                 [billId, productId, productName, batch, mrp, rate, qty, expiry, discount, cgst, sgst]
            );

            // Decrease stock if product exists - ensure productId is valid
            if (productId && !isNaN(productId)) {
                const [updateResult] = await conn.query(
                    `UPDATE products SET quantity = GREATEST(0, quantity - ?) WHERE id = ?`, 
                    [qty, productId]
                );
                console.log(`Updated product ${productId}: reduced quantity by ${qty}`);
            }
        }

        await conn.commit();
        conn.release();

        res.json({ message: 'Bill created', id: billId, bill_number: billNumber });
    } catch (err) {
        await conn.rollback().catch(() => {});
        conn.release();
        console.error('POST /api/bills', err);
        res.status(500).json({ error: 'Failed to create bill' });
    }
});

// Update an existing bill (edit)
app.put('/api/bills/:id', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const billId = Number(req.params.id);
        const body = req.body;

        // Fetch existing bill (and its items)
        const [billRows] = await conn.query('SELECT * FROM bills WHERE id = ?', [billId]);
        if (!billRows || billRows.length === 0) {
            conn.release();
            return res.status(404).json({ error: 'Bill not found' });
        }
        const existingBill = billRows[0];
        const [existingItems] = await conn.query('SELECT * FROM bill_items WHERE bill_id = ?', [billId]);

        // Incoming data
        const items = body.items || [];
        const patientName = body.patient_name || body.patientName || existingBill.patient_name;
        const patientMobile = body.patient_mobile || body.patientMobile || existingBill.patient_mobile;
        const doctorName = body.doctor_name || body.doctorName || existingBill.doctor_name;

        // --- NEW: Customer handling logic for updates ---
        let customerId = null;
        if (patientMobile) {
            const [existingCustomer] = await conn.query('SELECT id FROM customers WHERE mobile = ? LIMIT 1', [patientMobile]);
            if (existingCustomer.length > 0) {
                customerId = existingCustomer[0].id;
            } else {
                const [newCustomer] = await conn.query(
                    `INSERT INTO customers (name, mobile, doctor_name) VALUES (?, ?, ?)`,
                    [patientName, patientMobile, doctorName]
                );
                customerId = newCustomer.insertId;
            }
        }
        // --- END NEW: Customer handling logic for updates ---


        // Recalculate totals from new items
        let subtotal = 0, totalDiscount = 0, totalCGST = 0, totalSGST = 0;
        for (const it of items) {
            const rate = Number(it.rate || 0);
            const qty = Number(it.quantity || 0);
            const discount = Number(it.discount || 0);
            const cgst = Number(it.cgst || 0);
            const sgst = Number(it.sgst || 0);

            const itemSubtotal = rate * qty;
            const itemDiscount = itemSubtotal * (discount / 100);
            const taxable = itemSubtotal - itemDiscount;
            subtotal += itemSubtotal;
            totalDiscount += itemDiscount;
            totalCGST += taxable * (cgst / 100);
            totalSGST += taxable * (sgst / 100);
        }
        const grandTotal = subtotal - totalDiscount + totalCGST + totalSGST;

        // Begin transaction: update stock according to difference between existing & new items
        await conn.beginTransaction();

        // Build map of existing quantities per product (product_id may be null)
        const existingMap = {};
        for (const it of existingItems) {
            const pid = it.product_id ? Number(it.product_id) : `null-${it.id}`;
            existingMap[pid] = (existingMap[pid] || 0) + Number(it.quantity);
        }

        // Build map of new quantities per product
        const newMap = {};
        for (const it of items) {
            const pid = it.product_id ? Number(it.product_id) : `null-new-${Math.random()}`;
            newMap[pid] = (newMap[pid] || 0) + Number(it.quantity);
        }

        // For each product id present in either map, compute delta = existing - new
        // If delta > 0 => increase products.quantity by delta (return to stock)
        // If delta < 0 => decrease products.quantity by -delta (remove from stock) ; ensure not negative
        const allKeys = new Set([...Object.keys(existingMap), ...Object.keys(newMap)]);
        for (const k of allKeys) {
            // ignore pseudo keys for items without product_id
            if (String(k).startsWith('null-')) continue;
            const pid = Number(k);
            const oldQty = Number(existingMap[k] || 0);
            const newQty = Number(newMap[k] || 0);
            const delta = oldQty - newQty;
            if (delta > 0) {
                // old had more, return delta to stock
                await conn.query('UPDATE products SET quantity = quantity + ? WHERE id = ?', [delta, pid]);
                console.log(`Returned ${delta} units of product ${pid} to stock`);
            } else if (delta < 0) {
                const remove = -delta;
                // reduce stock by remove but ensure not negative
                await conn.query('UPDATE products SET quantity = GREATEST(0, quantity - ?) WHERE id = ?', [remove, pid]);
                console.log(`Removed ${remove} units of product ${pid} from stock`);
            }
        }

        // Delete existing bill_items then insert new ones
        await conn.query('DELETE FROM bill_items WHERE bill_id = ?', [billId]);

        for (const it of items) {
            const productId = it.product_id || it.productId || null;
            const productName = it.product_name || it.productName || it.name || '';
            const batch = it.batch || '';
            const rate = Number(it.rate || 0);
            const qty = Number(it.quantity || 0);
            const discount = Number(it.discount || 0);
            const cgst = Number(it.cgst || 0);
            const sgst = Number(it.sgst || 0);

            // Properly preserve MRP and Expiry from original bill items
            const mrp = Number(it.mrp || 0);
            const expiry = it.expiry || null;

            await conn.query(
                `INSERT INTO bill_items (bill_id, product_id, product_name, batch, mrp, rate, quantity, expiry, discount, cgst, sgst)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                 [billId, productId, productName, batch, mrp, rate, qty, expiry, discount, cgst, sgst]
            );
        }

        // Update bills table totals & header
        await conn.query(
            `UPDATE bills SET patient_name = ?, patient_mobile = ?, doctor_name = ?, subtotal = ?, total_discount = ?, total_cgst = ?, total_sgst = ?, grand_total = ?, customer_id = ? WHERE id = ?`,
            [patientName, patientMobile, doctorName, subtotal, totalDiscount, totalCGST, totalSGST, grandTotal, customerId, billId]
        );

        await conn.commit();
        conn.release();
        res.json({ message: 'Bill updated' });
    } catch (err) {
        await conn.rollback().catch(()=>{});
        conn.release();
        console.error('PUT /api/bills/:id', err);
        res.status(500).json({ error: 'Failed to update bill' });
    }
});

// ---------- Start Server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`API server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser`);
});

