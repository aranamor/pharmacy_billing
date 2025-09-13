-- Create the database if it doesn't exist
CREATE DATABASE IF NOT EXISTS pharmacy_db;

-- Use the newly created database
USE pharmacy_db;

-- Drop tables if they exist to start fresh
DROP TABLE IF EXISTS bill_items;
DROP TABLE IF EXISTS bills;
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
mrp DECIMAL(10, 2) NOT NULL,
sale_rate DECIMAL(10, 2) NOT NULL,
-- Change expiry to VARCHAR(7) to store YYYY-MM
expiry VARCHAR(7) NOT NULL,
cgst DECIMAL(5, 2) NOT NULL,
sgst DECIMAL(5, 2) NOT NULL,
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

-- Create the bills table
CREATE TABLE bills (
id INT AUTO_INCREMENT PRIMARY KEY,
bill_number VARCHAR(255) NOT NULL,
bill_date DATETIME NOT NULL,
patient_name VARCHAR(255) NOT NULL,
patient_mobile VARCHAR(15) NOT NULL,
doctor_name VARCHAR(255),
subtotal DECIMAL(10, 2) NOT NULL,
total_discount DECIMAL(10, 2) NOT NULL,
total_cgst DECIMAL(10, 2) NOT NULL,
total_sgst DECIMAL(10, 2) NOT NULL,
grand_total DECIMAL(10, 2) NOT NULL,
customer_id INT,
FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
);

-- Create the bill_items table to store product details for each bill
CREATE TABLE bill_items (
id INT AUTO_INCREMENT PRIMARY KEY,
bill_id INT NOT NULL,
product_id INT,
product_name VARCHAR(255) NOT NULL,
batch VARCHAR(255),
-- Add the MRP column here
mrp DECIMAL(10, 2),
rate DECIMAL(10, 2),
quantity INT NOT NULL,
-- Change expiry to VARCHAR(7) to store YYYY-MM
expiry VARCHAR(7),
discount DECIMAL(5, 2),
cgst DECIMAL(5, 2),
sgst DECIMAL(5, 2),
FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE
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

SELECT id, name, batch, expiry, mrp FROM products LIMIT 10;

