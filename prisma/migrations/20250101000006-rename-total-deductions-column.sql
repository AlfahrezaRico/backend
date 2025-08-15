-- Rename total_deductions to total_deductions_bpjs
ALTER TABLE payrolls RENAME COLUMN total_deductions TO total_deductions_bpjs;

-- Remove the deductions column (legacy field)
ALTER TABLE payrolls DROP COLUMN IF EXISTS deductions;
