-- Create payroll_components table
CREATE TABLE IF NOT EXISTS payroll_components (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('income', 'deduction')),
    category VARCHAR(50) NOT NULL CHECK (category IN ('fixed', 'variable', 'bpjs', 'allowance')),
    percentage DECIMAL(5,2) DEFAULT 0,
    amount DECIMAL(12,2) DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default payroll components
INSERT INTO payroll_components (name, type, category, percentage, amount, description) VALUES
('Gaji Pokok', 'income', 'fixed', 0, 0, 'Gaji pokok karyawan'),
('BPJS Ketenagakerjaan JHT (Perusahaan)', 'income', 'bpjs', 3.7, 0, 'Jaminan Hari Tua dari perusahaan'),
('BPJS Ketenagakerjaan JHT (Karyawan)', 'deduction', 'bpjs', 2, 0, 'Jaminan Hari Tua dari karyawan'),
('BPJS Kesehatan (Perusahaan)', 'income', 'bpjs', 4, 0, 'BPJS Kesehatan dari perusahaan'),
('BPJS Kesehatan (Karyawan)', 'deduction', 'bpjs', 1, 0, 'BPJS Kesehatan dari karyawan'),
('BPJS Ketenagakerjaan JKK (Perusahaan)', 'income', 'bpjs', 0.24, 0, 'Jaminan Kecelakaan Kerja dari perusahaan'),
('BPJS Ketenagakerjaan JKM (Perusahaan)', 'income', 'bpjs', 0.3, 0, 'Jaminan Kematian dari perusahaan'),
('Tunjangan Makan', 'income', 'allowance', 0, 0, 'Tunjangan makan harian'),
('Tunjangan Transport', 'income', 'allowance', 0, 0, 'Tunjangan transportasi'),
('Tunjangan Jabatan', 'income', 'allowance', 0, 0, 'Tunjangan berdasarkan jabatan'),
('Tunjangan Pulsa', 'income', 'allowance', 0, 0, 'Tunjangan pulsa dan internet'),
('Tunjangan Lembur', 'income', 'allowance', 0, 0, 'Tunjangan kerja lembur'),
('Kasbon', 'deduction', 'variable', 0, 0, 'Pinjaman karyawan'),
('Angsuran Kredit', 'deduction', 'variable', 0, 0, 'Angsuran kredit karyawan'),
('Telat', 'deduction', 'variable', 0, 0, 'Denda keterlambatan'),
('Alfa', 'deduction', 'variable', 0, 0, 'Denda ketidakhadiran'),
('Potongan Lainnya', 'deduction', 'variable', 0, 0, 'Potongan lainnya'),
('Bonus', 'income', 'variable', 0, 0, 'Bonus kinerja');

-- Create index for better performance
CREATE INDEX idx_payroll_components_type ON payroll_components(type);
CREATE INDEX idx_payroll_components_category ON payroll_components(category);
CREATE INDEX idx_payroll_components_active ON payroll_components(is_active); 