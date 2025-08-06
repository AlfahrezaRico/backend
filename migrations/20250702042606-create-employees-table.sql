-- Enable Row Level Security
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;

-- Create employees table if not exists
CREATE TABLE IF NOT EXISTS public.employees (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id),
    first_name VARCHAR(255) NOT NULL,
    last_name VARCHAR(255),
    email VARCHAR(255) NOT NULL UNIQUE,
    phone VARCHAR(20),
    hire_date DATE NOT NULL,
    position VARCHAR(100),
    department VARCHAR(100),
    salary DECIMAL(12,2),
    bank_account VARCHAR(50),
    bank_name VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- Create updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = TIMEZONE('utc'::text, NOW());
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_employees_updated_at
    BEFORE UPDATE ON public.employees
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Create policies
CREATE POLICY "Super Admin can manage all employees"
    ON public.employees
    AS PERMISSIVE
    FOR ALL
    TO authenticated
    USING (auth.jwt() ->> 'role' = 'Super Admin')
    WITH CHECK (auth.jwt() ->> 'role' = 'Super Admin');

CREATE POLICY "HRD can view and manage employees"
    ON public.employees
    AS PERMISSIVE
    FOR ALL
    TO authenticated
    USING (auth.jwt() ->> 'role' = 'HRD')
    WITH CHECK (auth.jwt() ->> 'role' = 'HRD');

CREATE POLICY "Employees can view their own data"
    ON public.employees
    AS PERMISSIVE
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);