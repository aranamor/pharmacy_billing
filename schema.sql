-- Create the database if it doesn't exist
CREATE DATABASE IF NOT EXISTS pharmacy_db;

-- Use the newly created database
USE pharmacy_db;

-- Drop tables if they exist to start fresh
DROP TABLE IF EXISTS bill_items;
DROP TABLE IF EXISTS bills;
DROP TABLE IF EXISTS purchase_bill_items;
DROP TABLE IF EXISTS purchase_bills;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS settings;

-- Create the products table
CREATE TABLE products (
id INT AUTO_INCREMENT PRIMARY KEY,
name VARCHAR(255) NOT NULL,
hsn VARCHAR(255) NOT NULL,
batch VARCHAR(255) NOT NULL,
quantity INT NOT NULL,
packaging VARCHAR(50),
mrp DECIMAL(10, 2) NOT NULL,
purchase_rate DECIMAL(10, 2) NOT NULL,
sale_rate DECIMAL(10, 2) NOT NULL, -- Exclusive of GST
sale_rate_inclusive DECIMAL(10, 2) NOT NULL, -- Inclusive of GST
expiry VARCHAR(7) NOT NULL,
cgst DECIMAL(5, 2) NOT NULL DEFAULT 0,
sgst DECIMAL(5, 2) NOT NULL DEFAULT 0,
UNIQUE KEY unique_product (name, batch)
);

-- Create the customers table
CREATE TABLE customers (
id INT AUTO_INCREMENT PRIMARY KEY,
name VARCHAR(255) NOT NULL,
mobile VARCHAR(15) NOT NULL,
doctor_name VARCHAR(255),
UNIQUE KEY unique_customer_mobile (mobile)
);

-- Create the bills table (Sales bills do not have IGST)
-- FIX: Changed bill_date from DATE to TIMESTAMP with a default value.
-- This makes the database the single source of truth for bill creation time,
-- and it will be stored correctly in the session's timezone (IST).
CREATE TABLE bills (
id INT AUTO_INCREMENT PRIMARY KEY,
bill_number VARCHAR(255) NOT NULL,
bill_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
patient_name VARCHAR(255) NOT NULL,
patient_mobile VARCHAR(15) NOT NULL,
doctor_name VARCHAR(255),
subtotal DECIMAL(10, 2) NOT NULL,
total_discount DECIMAL(10, 2) NOT NULL,
total_cgst DECIMAL(10, 2) NOT NULL DEFAULT 0,
total_sgst DECIMAL(10, 2) NOT NULL DEFAULT 0,
grand_total DECIMAL(10, 2) NOT NULL,
customer_id INT,
FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
);

-- Create the bill_items table (Sales items do not have IGST)
CREATE TABLE bill_items (
id INT AUTO_INCREMENT PRIMARY KEY,
bill_id INT NOT NULL,
product_id INT,
product_name VARCHAR(255) NOT NULL,
batch VARCHAR(255),
mrp DECIMAL(10, 2),
rate DECIMAL(10, 2),
quantity INT NOT NULL,
expiry VARCHAR(7),
discount DECIMAL(5, 2),
cgst DECIMAL(5, 2) DEFAULT 0,
sgst DECIMAL(5, 2) DEFAULT 0,
FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE
);

-- Create the purchase_bills table
CREATE TABLE purchase_bills (
id INT AUTO_INCREMENT PRIMARY KEY,
supplier_name VARCHAR(255) NOT NULL,
bill_number VARCHAR(255) NOT NULL,
bill_date DATE NOT NULL,
total_amount DECIMAL(10, 2) NOT NULL,
tax_type VARCHAR(10) NOT NULL, -- 'IGST' or 'CSGST'
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create the purchase_bill_items table
CREATE TABLE purchase_bill_items (
id INT AUTO_INCREMENT PRIMARY KEY,
purchase_bill_id INT NOT NULL,
product_name VARCHAR(255) NOT NULL,
hsn VARCHAR(255) NOT NULL,
batch VARCHAR(255) NOT NULL,
packaging VARCHAR(50),
quantity INT NOT NULL,
mrp DECIMAL(10, 2) NOT NULL,
purchase_rate DECIMAL(10, 2) NOT NULL,
sale_rate DECIMAL(10, 2) NOT NULL, -- Exclusive of GST
sale_rate_inclusive DECIMAL(10, 2) NOT NULL, -- Inclusive of GST
discount DECIMAL(5, 2) DEFAULT 0,
expiry VARCHAR(7) NOT NULL,
cgst DECIMAL(5, 2) NOT NULL DEFAULT 0,
sgst DECIMAL(5, 2) NOT NULL DEFAULT 0,
igst DECIMAL(5, 2) NOT NULL DEFAULT 0,
amount DECIMAL(10, 2) NOT NULL,
FOREIGN KEY (purchase_bill_id) REFERENCES purchase_bills(id) ON DELETE CASCADE
);

-- Create the settings table
CREATE TABLE settings (
setting_key VARCHAR(255) PRIMARY KEY,
setting_value VARCHAR(255)
);

-- Insert initial settings
INSERT INTO settings (setting_key, setting_value) VALUES
('shopName', 'GENERICART MEDICINE STORE'),
('gst', '16GLDPD3626M1Z0'),
('phone', '6009700852'),
('email', 'genericartcr@gmail.com'),
('address', 'Near MBB Club, Shivnagar, 799001'),
('lowStockThreshold', '10');
