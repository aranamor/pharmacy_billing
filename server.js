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
    queueLimit: 0,
    // FIX: Set connection timezone to IST (+05:30).
    // This is the most critical change. It ensures all date/time functions
    // like NOW(), CURDATE(), and CURRENT_TIMESTAMP operate in IST for this connection.
    timezone: '+05:30'
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

// ---------- NEW ENDPOINT FOR CURRENT DATE ----------
// Provides a reliable IST date for client-side defaults.
app.get('/api/current-ist-date', async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT CURDATE() as today");
        // The date will be returned in 'YYYY-MM-DD' format which is perfect for an <input type="date">
        const date = new Date(rows[0].today);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        res.json({ currentDate: `${year}-${month}-${day}` });
    } catch (err) {
        console.error('GET /api/current-ist-date error:', err);
        res.status(500).json({ error: 'Failed to fetch current date' });
    }
});


// ---------- DASHBOARD ----------
// FIX: New endpoint to calculate dashboard stats reliably on the server.
// This avoids client-side timezone issues and centralizes the logic.
app.get('/api/dashboard-stats', async (req, res) => {
    try {
        // Use CURDATE() which will be in IST due to the connection timezone setting
        const today = 'CURDATE()';

        const [salesTodayResult] = await pool.query(`SELECT SUM(grand_total) as totalSales, COUNT(id) as billCount FROM bills WHERE DATE(bill_date) = ${today}`);
        
        const [inventoryStatsResult] = await pool.query(`SELECT SUM(quantity) as totalItems FROM products`);
        
        const [settingsRows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'lowStockThreshold'");
        const lowStockThreshold = settingsRows.length > 0 ? Number(settingsRows[0].setting_value) : 10;
        const [lowStockResult] = await pool.query('SELECT COUNT(id) as lowStockCount FROM products WHERE quantity <= ?', [lowStockThreshold]);
        
        const [expiringResult] = await pool.query(`
            SELECT COUNT(id) as expiringCount 
            FROM products 
            WHERE expiry IS NOT NULL 
            AND STR_TO_DATE(CONCAT(expiry, '-01'), '%Y-%m-%d') BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 1 MONTH)
        `);

        const [recentTransactions] = await pool.query('SELECT * FROM bills ORDER BY id DESC LIMIT 5');

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
        const rows = await query('SELECT * FROM products ORDER BY id DESC');
        res.json(rows);
    } catch (err) {
        console.error('GET /api/products error:', err);
        res.status(500).json({ error: 'Failed to fetch products' });
    }
});

app.get('/api/products/search', async (req, res) => {
    try {
        const q = (req.query.query || '').trim();
        if (!q) {
            const rows = await query('SELECT * FROM products WHERE quantity > 0 ORDER BY id DESC LIMIT 50');
            return res.json(rows);
        }
        const like = `%${q}%`;
        const rows = await query(
            `SELECT * FROM products WHERE (name LIKE ? OR batch LIKE ? OR hsn LIKE ?) AND quantity > 0 ORDER BY id DESC LIMIT 50`,
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
        const { name, hsn, batch, quantity, packaging, mrp, saleRate, saleRateInclusive, expiry, cgst, sgst } = req.body;
        const result = await query(
            `INSERT INTO products (name, hsn, batch, quantity, packaging, mrp, purchase_rate, sale_rate, sale_rate_inclusive, expiry, cgst, sgst) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, hsn, batch, Number(quantity || 0), packaging, Number(mrp || 0), 0, Number(saleRate || 0), Number(saleRateInclusive || 0), expiry, Number(cgst || 0), Number(sgst || 0)]
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

app.post('/api/customers', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { name, mobile, doctorName } = req.body;
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


// ---------- BILLS (SALES) ----------
app.get('/api/bills', async (req, res) => {
    try {
        const rows = await query('SELECT * FROM bills ORDER BY id DESC');
        res.json(rows);
    } catch (err) {
        console.error('GET /api/bills', err);
        res.status(500).json({ error: 'Failed to list bills' });
    }
});

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
        
        conn.release();
        res.json({ ...bill, items });
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
        const billNumber = body.billNumber || `BILL-${Date.now()}`;
        
        const { patientName, patientMobile, doctorName, items } = body;

        let customerId = null;
        if (patientMobile) {
            const [existing] = await conn.query('SELECT id FROM customers WHERE mobile = ? LIMIT 1', [patientMobile]);
            if (existing.length > 0) {
                customerId = existing[0].id;
            } else {
                const [newCustomer] = await conn.query('INSERT INTO customers (name, mobile, doctor_name) VALUES (?, ?, ?)', [patientName, patientMobile, doctorName]);
                customerId = newCustomer.insertId;
            }
        }

        let subtotal = 0, totalDiscount = 0, totalCGST = 0, totalSGST = 0;
        for (const it of items) {
            const taxable = (it.rate * it.quantity) * (1 - (it.discount / 100));
            subtotal += it.rate * it.quantity;
            totalDiscount += (it.rate * it.quantity) * (it.discount / 100);
            totalCGST += taxable * (it.cgst / 100);
            totalSGST += taxable * (it.sgst / 100);
        }
        const grandTotal = subtotal - totalDiscount + totalCGST + totalSGST;

        await conn.beginTransaction();

        const [billInsert] = await conn.query(
            `INSERT INTO bills (bill_number, patient_name, patient_mobile, doctor_name, subtotal, total_discount, total_cgst, total_sgst, grand_total, customer_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
             [billNumber, patientName, patientMobile, doctorName, subtotal, totalDiscount, totalCGST, totalSGST, grandTotal, customerId]
        );
        const billId = billInsert.insertId;

        for (const it of items) {
            await conn.query(
                `INSERT INTO bill_items (bill_id, product_id, product_name, batch, mrp, rate, quantity, expiry, discount, cgst, sgst)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                 [billId, it.product_id, it.name, it.batch, it.mrp, it.rate, it.quantity, it.expiry, it.discount, it.cgst, it.sgst]
            );
            if (it.product_id) {
                await conn.query(`UPDATE products SET quantity = GREATEST(0, quantity - ?) WHERE id = ?`, [it.quantity, it.product_id]);
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

// Update an existing bill
app.put('/api/bills/:id', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const billId = Number(req.params.id);
        const body = req.body;

        const [billRows] = await conn.query('SELECT * FROM bills WHERE id = ?', [billId]);
        if (!billRows[0]) return res.status(404).json({ error: 'Bill not found' });
        
        const [existingItems] = await conn.query('SELECT * FROM bill_items WHERE bill_id = ?', [billId]);
        
        let { items, patient_name, patient_mobile, doctor_name } = body;
        
        let subtotal = 0, totalDiscount = 0, totalCGST = 0, totalSGST = 0;
        for (const it of items) {
            const currentRate = Number(it.rate);
            const currentQty = Number(it.quantity);
            const currentDiscount = Number(it.discount);
            const currentCgst = Number(it.cgst);
            const currentSgst = Number(it.sgst);

            const itemSubtotal = currentRate * currentQty;
            const itemDiscountAmount = itemSubtotal * (currentDiscount / 100);
            const taxable = itemSubtotal - itemDiscountAmount;
            
            subtotal += itemSubtotal;
            totalDiscount += itemDiscountAmount;
            totalCGST += taxable * (currentCgst / 100);
            totalSGST += taxable * (currentSgst / 100);
        }
        const grandTotal = subtotal - totalDiscount + totalCGST + totalSGST;

        await conn.beginTransaction();

        const existingMap = {};
        for (const it of existingItems) {
            if(it.product_id) existingMap[it.product_id] = (existingMap[it.product_id] || 0) + it.quantity;
        }

        const newMap = {};
        for (const it of items) {
             if(it.product_id) newMap[it.product_id] = (newMap[it.product_id] || 0) + it.quantity;
        }

        const allKeys = new Set([...Object.keys(existingMap), ...Object.keys(newMap)]);
        for (const k of allKeys) {
            const pid = Number(k);
            const delta = (existingMap[k] || 0) - (newMap[k] || 0);
            if (delta !== 0) {
                 await conn.query('UPDATE products SET quantity = quantity + ? WHERE id = ?', [delta, pid]);
            }
        }

        await conn.query('DELETE FROM bill_items WHERE bill_id = ?', [billId]);
        for (const it of items) {
            await conn.query(
                `INSERT INTO bill_items (bill_id, product_id, product_name, batch, mrp, rate, quantity, expiry, discount, cgst, sgst)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                 [billId, it.product_id, it.product_name, it.batch, it.mrp, it.rate, it.quantity, it.expiry, it.discount, it.cgst, it.sgst]
            );
        }

        await conn.query(
            `UPDATE bills SET patient_name = ?, patient_mobile = ?, doctor_name = ?, subtotal = ?, total_discount = ?, total_cgst = ?, total_sgst = ?, grand_total = ? WHERE id = ?`,
            [patient_name, patient_mobile, doctor_name, subtotal, totalDiscount, totalCGST, totalSGST, grandTotal, billId]
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

// ---------- PURCHASES ----------
app.get('/api/purchases', async (req, res) => {
    try {
        const rows = await query('SELECT * FROM purchase_bills ORDER BY bill_date DESC, id DESC');
        res.json(rows);
    } catch (err) {
        console.error('GET /api/purchases error:', err);
        res.status(500).json({ error: 'Failed to fetch purchase bills' });
    }
});

app.get('/api/purchases/:id', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const purchaseId = Number(req.params.id);
        const [pRows] = await conn.query('SELECT * FROM purchase_bills WHERE id = ?', [purchaseId]);
        if (!pRows || pRows.length === 0) {
            conn.release();
            return res.status(404).json({ error: 'Purchase Bill not found' });
        }
        const purchaseBill = pRows[0];
        const [items] = await conn.query('SELECT * FROM purchase_bill_items WHERE purchase_bill_id = ?', [purchaseId]);
        
        conn.release();
        res.json({ ...purchaseBill, items });
    } catch (err) {
        conn.release();
        console.error('GET /api/purchases/:id', err);
        res.status(500).json({ error: 'Failed to fetch purchase bill' });
    }
});

app.post('/api/purchases', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { supplierName, billNumber, billDate, taxType, items } = req.body;

        if (!supplierName || !billNumber || !billDate || !taxType || !items || items.length === 0) {
            return res.status(400).json({ error: 'Missing required fields for purchase bill.' });
        }
        
        const totalAmount = items.reduce((sum, item) => {
            const base = item.purchaseRate * item.quantity;
            const discounted = base * (1 - (item.discount / 100));
            const totalGstPercent = item.igst > 0 ? item.igst : (item.cgst + item.sgst);
            const gstAmount = discounted * (totalGstPercent / 100);
            return sum + discounted + gstAmount;
        }, 0);
        const roundedTotal = Math.round(totalAmount);

        await conn.beginTransaction();

        const [purchaseInsert] = await conn.query(
            `INSERT INTO purchase_bills (supplier_name, bill_number, bill_date, total_amount, tax_type) VALUES (?, ?, ?, ?, ?)`,
            [supplierName, billNumber, billDate, roundedTotal, taxType]
        );
        const purchaseBillId = purchaseInsert.insertId;

        for (const item of items) {
            const { productName, hsn, batch, packaging, quantity, mrp, purchaseRate, saleRate, saleRateIncl, discount, expiry, cgst, sgst, igst, amount } = item;
            
            await conn.query(
                `INSERT INTO purchase_bill_items (purchase_bill_id, product_name, hsn, batch, packaging, quantity, mrp, purchase_rate, sale_rate, sale_rate_inclusive, discount, expiry, cgst, sgst, igst, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [purchaseBillId, productName, hsn, batch, packaging, quantity, mrp, purchaseRate, saleRate, saleRateIncl, discount, expiry, cgst, sgst, igst, amount]
            );

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
                [productName, hsn, batch, packaging, quantity, mrp, purchaseRate, saleRate, saleRateIncl, expiry, item.saleCgst, item.saleSgst]
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
                queryStr = `SELECT bill_number, DATE_FORMAT(bill_date, '%Y-%m-%d') as date, patient_name, grand_total FROM bills WHERE DATE(bill_date) BETWEEN ? AND ? ORDER BY bill_date DESC`;
                reportData = await query(queryStr, [fromDate, toDate]);
                break;
            case 'gst':
                queryStr = `SELECT bill_number, DATE_FORMAT(bill_date, '%Y-%m-%d') as date, subtotal, total_discount, (subtotal - total_discount) as taxable_value, total_cgst, total_sgst, grand_total FROM bills WHERE DATE(bill_date) BETWEEN ? AND ? ORDER BY bill_date DESC`;
                reportData = await query(queryStr, [fromDate, toDate]);
                break;
            case 'inventory':
                queryStr = `SELECT name, packaging, hsn, batch, quantity, mrp, purchase_rate, sale_rate_inclusive, expiry FROM products ORDER BY name`;
                reportData = await query(queryStr);
                break;
            case 'purchases':
                queryStr = `SELECT bill_number, supplier_name, DATE_FORMAT(bill_date, '%Y-%m-%d') as date, tax_type, total_amount FROM purchase_bills WHERE bill_date BETWEEN ? AND ? ORDER BY bill_date DESC`;
                reportData = await query(queryStr, [fromDate, toDate]);
                break;
            case 'expiry':
                 queryStr = `SELECT name, batch, quantity, expiry FROM products WHERE expiry IS NOT NULL AND STR_TO_DATE(CONCAT(expiry, '-01'), '%Y-%m-%d') < CURDATE() ORDER BY expiry`;
                 reportData = await query(queryStr);
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
                    JOIN
                        products p ON bi.product_id = p.id
                    WHERE
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

