import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import * as nodeCrypto from "crypto";
if (!globalThis.crypto) {
  // @ts-ignore
  globalThis.crypto = nodeCrypto;
}
import cors from 'cors';
import fetch from 'node-fetch';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import archiver from 'archiver';
import stream from 'stream';
import multer from 'multer';
import unzipper from 'unzipper';
import cookieParser from 'cookie-parser';
import { lucia } from "./lucia.js"; // gunakan .js jika sudah build ke ESM, .ts jika development
import { PrismaClient } from "@prisma/client";
import { Argon2id } from "oslo/password";
import { nanoid } from 'nanoid';
import path from 'path';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
import payrollComponentsRouter from './payroll-components.js';
import * as XLSX from 'xlsx';

const prisma = new PrismaClient();

// Load environment variables from .env file
dotenv.config();

const app = express();
const port = process.env.PORT || 3001;
const isProd = process.env.NODE_ENV === 'production';

// Set trust proxy jika di production (Railway, Vercel, dsb)
if (isProd) {
  app.set('trust proxy', 1);
}

const upload = multer({ storage: multer.memoryStorage() });
const izinUpload = multer({
  storage: multer.memoryStorage(), // Gunakan memory storage untuk upload ke Supabase
  limits: { fileSize: 2 * 1024 * 1024 }, // Kurangi ukuran file ke 2MB
  fileFilter: (req, file, cb) => {
    if (!['image/jpeg', 'image/png'].includes(file.mimetype)) {
      return cb(new Error('Hanya file JPG/PNG yang diizinkan'));
    }
    cb(null, true);
  }
});

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);
const BUCKET = process.env.SUPABASE_BUCKET || 'izin-sakit';

// Middleware
app.use(helmet());

// CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGIN
  ? process.env.ALLOWED_ORIGIN.split(',').map(origin => origin.trim())
  : ["http://localhost:5173", "http://localhost:3000", "http://127.0.0.1:5173"];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true); // Allow non-browser requests
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    } else {
      console.log('CORS blocked origin:', origin, 'Allowed origins:', allowedOrigins);
      return callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(cookieParser());

// Lucia Auth setup
// Helper: get Lucia user from request
function getLuciaUser(req: any) {
  // Lucia injects req.user if session valid
  return req.user || null;
}

// Check for required environment variables
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error("Error: SUPABASE_URL and SUPABASE_SERVICE_KEY must be defined in your .env file");
  process.exit(1);
}

// Rate limiter untuk login dan endpoint sensitif
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 menit
  max: 10, // max 10 request per 15 menit per IP
  message: { error: 'Terlalu banyak percobaan. Silakan coba lagi nanti.' }
});
app.use('/api/auth/login', authLimiter);
app.use('/api/admin-create-user', authLimiter);

// --- API Routes ---

// Health check route
app.get('/api/health', (req: Request, res: Response) => {
  try {
    res.json({ 
      status: 'ok', 
      timestamp: new Date(),
      environment: process.env.NODE_ENV,
      cors: {
        allowedOrigins: process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.split(',') : ['default'],
        isDevelopment: process.env.NODE_ENV !== 'production'
      }
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date()
    });
  }
});

// Test endpoint untuk cek NIK
app.post('/api/test-nik', async (req: Request, res: Response) => {
  try {
    const { nik } = req.body;
    console.log('Testing NIK save:', nik);
    
    const testEmployee = await prisma.employees.create({
      data: {
        first_name: 'Test',
        last_name: 'NIK',
        email: `test-${Date.now()}@example.com`,
        position: 'Test',
        hire_date: new Date(),
        nik: nik,
        departemen_id: null // Add required field
      }
    });
    
    console.log('Test employee created:', testEmployee);
    res.json({ success: true, employee: testEmployee });
  } catch (err) {
    console.error('Test NIK error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// Test endpoint untuk cek department matching
app.post('/api/test-department', async (req: Request, res: Response) => {
  try {
    const { departmentName } = req.body;
    console.log('Testing department matching for:', departmentName);
    
    const departemenList = await prisma.departemen.findMany();
    console.log('Available departments:', departemenList.map(d => d.nama));
    
    const departemen = departemenList.find(d => {
      const dbName = d.nama.toLowerCase();
      const csvName = departmentName.toLowerCase();
      
      console.log('Comparing:', dbName, 'vs', csvName);
      
      // Exact match
      if (dbName === csvName) {
        console.log('Exact match found:', d.nama);
        return true;
      }
      
      // Additional matching for "Operational"
      if (dbName === 'operational' && csvName === 'operational') {
        console.log('Direct match found (Operational):', d.nama);
        return true;
      }
      
      return false;
    });
    
    if (departemen) {
      console.log('Department found:', departemen);
      
      // Test NIK config
      const nikConfig = await prisma.department_nik_config.findFirst({
        where: {
          department_id: departemen.id,
          is_active: true
        }
      });
      
      console.log('NIK Config found:', nikConfig);
      
      res.json({ 
        success: true, 
        departemen: departemen,
        nikConfig: nikConfig,
        availableDepartments: departemenList.map(d => d.nama)
      });
    } else {
      res.json({ 
        success: false, 
        error: 'Department not found',
        availableDepartments: departemenList.map(d => d.nama)
      });
    }
  } catch (err) {
    console.error('Test department error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// Fix existing employees - update departemen_id for all employees with department "Operational"
app.post('/api/fix-departments', async (req: Request, res: Response) => {
  try {
    console.log('Fixing departments for existing employees...');
    
    // Get Operational department
    const operationalDept = await prisma.departemen.findFirst({
      where: { nama: 'Operational' }
    });
    
    if (!operationalDept) {
      return res.status(404).json({ error: 'Operational department not found' });
    }
    
    console.log('Found Operational department:', operationalDept);
    
    // Update all employees with department "Operational" and null departemen_id
    const result = await prisma.employees.updateMany({
      where: {
        // department: 'Operational', // Removed - no longer exists in schema
        departemen_id: null
      },
      data: {
        departemen_id: operationalDept.id
      }
    });
    
    console.log('Updated employees count:', result.count);
    
    // Generate NIK for updated employees
    const updatedEmployees = await prisma.employees.findMany({
      where: {
        // department: 'Operational', // Removed - no longer exists in schema
        departemen_id: operationalDept.id,
        nik: null
      }
    });
    
    console.log('Employees to generate NIK for:', updatedEmployees.length);
    
    // Get NIK config
    const nikConfig = await prisma.department_nik_config.findFirst({
      where: {
        department_id: operationalDept.id,
        is_active: true
      }
    });
    
    if (nikConfig) {
      let currentSequence = nikConfig.current_sequence;
      
      for (const employee of updatedEmployees) {
        // Generate NIK
        const nik = nikConfig.prefix + currentSequence.toString().padStart(nikConfig.sequence_length, '0');
        
        // Update employee with NIK
        await prisma.employees.update({
          where: { id: employee.id },
          data: { nik: nik }
        });
        
        currentSequence++;
      }
      
      // Update NIK config sequence
      await prisma.department_nik_config.update({
        where: { id: nikConfig.id },
        data: { current_sequence: currentSequence }
      });
      
      console.log('Generated NIK for', updatedEmployees.length, 'employees');
    }
    
    res.json({ 
      success: true, 
      updatedCount: result.count,
      nikGenerated: updatedEmployees.length,
      department: operationalDept
    });
    
  } catch (err) {
    console.error('Fix departments error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// Test database connection
app.get('/api/health/db', async (req: Request, res: Response) => {
  try {
    // Test database connection
    await prisma.$queryRaw`SELECT 1`;
    
    // Test basic queries
    const employeeCount = await prisma.employees.count();
    const departmentCount = await prisma.departemen.count();
    
    res.json({ 
      status: 'ok', 
      database: 'connected',
      counts: {
        employees: employeeCount,
        departments: departmentCount
      },
      timestamp: new Date()
    });
  } catch (error) {
    console.error('Database health check failed:', error);
    res.status(500).json({ 
      status: 'error', 
      database: 'disconnected',
      error: error instanceof Error ? error.message : 'Database connection failed',
      timestamp: new Date()
    });
  }
});

// Login route (POST)
app.post('/api/auth/login', async (req: Request, res: Response) => {
  const loginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(6)
  });
  const parseResult = loginSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Format email atau password tidak valid.' });
  }
  const { email, password } = parseResult.data;
  try {
    const user = await prisma.users.findFirst({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: 'Email tidak ditemukan' });
    }
    if (!user.encrypted_password) {
      return res.status(401).json({ error: 'User belum punya password.' });
    }
    // Verifikasi password hash
    const valid = await new Argon2id().verify(user.encrypted_password, password);
    if (!valid) {
      return res.status(401).json({ error: 'Password salah' });
    }
    // Buat session manual
    const sessionId = nanoid();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30); // 30 hari
    await prisma.session.create({
      data: {
        id: sessionId,
        user_id: user.id, // snake_case sesuai schema.prisma dan Prisma Client
        expiresAt
      }
    });
    res.cookie('auth_session', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
    });
    res.json({ user: { id: user.id, email: user.email, role: user.role } });
    // Setelah verifikasi login sukses, update last_login
    await prisma.users.update({
      where: { id: user.id },
      data: { last_login: new Date().toISOString() }
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint logout: hapus cookie token
app.post('/api/auth/logout', (req, res) => {
  res.cookie('auth_session', '', {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    path: '/',
    // domain: 'yourdomain.com',
    maxAge: 0
  });
  res.json({ message: 'Logged out' });
});

// Lucia Auth: Login endpoint (AMAN, tidak mengganggu Supabase Auth)
app.post('/api/auth/lucia-login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email dan password wajib diisi" });
  try {
    const user = await prisma.users.findFirst({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: "Email tidak ditemukan" });
    }
    if (!user.encrypted_password) {
      return res.status(401).json({ error: "User belum punya password." });
    }
    const valid = await new Argon2id().verify(user.encrypted_password, password);
    if (!valid) {
      return res.status(401).json({ error: "Password salah" });
    }
    // Buat session manual
    const sessionId = nanoid();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30); // 30 hari
    await prisma.session.create({
      data: {
        id: sessionId,
        user_id: user.id, // snake_case sesuai schema.prisma dan Prisma Client
        expiresAt
      }
    });
    res.cookie('auth_session', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
    });
    res.json({ user: { id: user.id, email: user.email, role: user.role } });
    // Setelah verifikasi login sukses, update last_login
    await prisma.users.update({
      where: { id: user.id },
      data: { last_login: new Date().toISOString() }
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Lucia Auth: Logout endpoint
app.post('/api/auth/lucia-logout', async (req, res) => {
  // Ambil session id dari cookie
  const sessionId = req.cookies['auth_session'];
  if (sessionId) {
    await prisma.session.delete({ where: { id: sessionId } });
    res.clearCookie('auth_session', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
    });
  }
  res.status(204).end();
});

// === Employees Endpoints ===
app.get('/api/employees', async (req, res) => {
  try {
    const includeDepartemen = req.query.include_departemen === '1';
    console.log('Fetching employees with includeDepartemen:', includeDepartemen);
    
    if (req.query.user_id) {
      const user_id = Array.isArray(req.query.user_id) ? req.query.user_id[0] : req.query.user_id as string;
      console.log('Fetching employee for user_id:', user_id);
      
      const employee = await prisma.employees.findFirst({ 
        where: { user_id }
      });
      
      if (!employee) {
        console.log('Employee not found for user_id:', user_id);
        return res.status(404).json({ error: 'Employee not found' });
      }
      
      // Jika perlu include departemen, fetch secara terpisah
      if (includeDepartemen) {
        try {
          if (employee.departemen_id) {
            const departemen = await prisma.departemen.findUnique({
              where: { id: employee.departemen_id }
            });
            (employee as any).departemen = departemen;
            console.log('Found departemen for employee:', departemen?.nama);
          } else {
            (employee as any).departemen = null;
            console.log('No departemen_id for employee');
          }
        } catch (deptError) {
          console.error('Error fetching departemen:', deptError);
          (employee as any).departemen = null;
        }
      }
      
      console.log('Found employee:', employee.id);
      return res.json(employee);
    }
    
    console.log('Fetching all employees...');
    const employees = await prisma.employees.findMany({
      orderBy: { first_name: 'asc' }
    });
    
    console.log('Found employees count:', employees.length);
    
    // Jika perlu include departemen, fetch secara terpisah
    if (includeDepartemen && employees.length > 0) {
      try {
        const departemenIds = [...new Set(employees.map(emp => emp.departemen_id).filter((id): id is string => id !== null))];
        console.log('Departemen IDs to fetch:', departemenIds);
        
        let departemenList: any[] = [];
        
        if (departemenIds.length > 0) {
          departemenList = await prisma.departemen.findMany({
            where: { id: { in: departemenIds } }
          });
          
          const departemenMap = new Map(departemenList.map((dept: any) => [dept.id, dept]));
          
          employees.forEach(emp => {
            if (emp.departemen_id) {
              (emp as any).departemen = departemenMap.get(emp.departemen_id) || null;
            }
          });
        }
        
        // Handle employees dengan departemen_id null tapi ada department field
        employees.forEach(emp => {
          if (!emp.departemen_id) {
            // Coba match dengan nama department di database (jika ada field department di CSV)
            const matchingDept = departemenList?.find((dept: any) => 
              dept.nama.toLowerCase() === ((emp as any).department || '').toLowerCase()
            );
            if (matchingDept) {
              (emp as any).departemen = matchingDept;
            }
          }
        });
        
        // Jika departemenList kosong, set departemen ke null untuk semua employees
        if (departemenList.length === 0) {
          employees.forEach(emp => {
            (emp as any).departemen = null;
          });
        }
        
        // Debug: Log sample employee data
        if (employees.length > 0) {
          console.log('Sample employee data:', {
            id: employees[0].id,
            first_name: employees[0].first_name,
            last_name: employees[0].last_name,
            // department: employees[0].department, // Removed - no longer exists in schema
            departemen_id: employees[0].departemen_id,
            departemen: (employees[0] as any).departemen
          });
        }
      } catch (deptError) {
        console.error('Error fetching departemen data:', deptError);
        // Jika gagal fetch departemen, tetap return employees tanpa departemen
        employees.forEach(emp => {
          (emp as any).departemen = null;
        });
      }
    }
    
    console.log('First employee sample:', employees[0] ? {
      id: employees[0].id,
      first_name: employees[0].first_name,
      last_name: employees[0].last_name,
      email: employees[0].email,
      departemen_id: employees[0].departemen_id,
      departemen: (employees[0] as any).departemen
    } : 'No employees found');
    
    res.json(employees);
  } catch (err) {
    console.error('Error fetching employees:', err);
    console.error('Error details:', {
      message: err instanceof Error ? err.message : 'Unknown error',
      stack: err instanceof Error ? err.stack : undefined,
      name: err instanceof Error ? err.name : 'Unknown'
    });
    
    // Return empty array instead of error if it's just no data
    if (err instanceof Error && (err.message.includes('table') || err.message.includes('relation'))) {
      console.log('Database table error, returning empty array');
      return res.json([]);
    }
    
    res.status(500).json({ 
      error: 'Gagal mengambil data employees',
      details: err instanceof Error ? err.message : 'Unknown error'
    });
  }
});

app.post('/api/employees', async (req, res) => {
  try {
    const data = req.body;
    
    // Generate NIK if not provided
    let nik = data.nik;
    if (!nik && data.departemen_id) {
      // Get department info
      const department = await prisma.departemen.findUnique({
        where: { id: data.departemen_id }
      });
      
      if (department) {
        // Get NIK configuration for this department
        const nikConfig = await prisma.department_nik_config.findFirst({
          where: {
            department_id: data.departemen_id,
            is_active: true
          }
        });
        
        if (nikConfig) {
          // Generate NIK tanpa separator
          nik = nikConfig.prefix + 
                nikConfig.current_sequence.toString().padStart(nikConfig.sequence_length, '0');
          
          // Update sequence
          await prisma.department_nik_config.update({
            where: { id: nikConfig.id },
            data: { current_sequence: nikConfig.current_sequence + 1 }
          });
        }
      }
    }
    
    // Hapus field department dari data jika ada
    const { department, ...employeeData } = data;
    
    const emp = await prisma.employees.create({ 
      data: {
        ...employeeData,
        nik,
      departemen_id: data.departemen_id || null
      }
    });
    res.status(201).json(emp);
  } catch (err) {
    console.error('Error creating employee:', err);
    res.status(500).json({ error: 'Gagal menambah karyawan' });
  }
});

// Delete employee endpoint
app.delete('/api/employees/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Validasi UUID
    const idSchema = z.string().uuid();
    if (!idSchema.safeParse(id).success) {
      return res.status(400).json({ error: 'ID tidak valid' });
    }

    // Cek apakah employee exists
    const employee = await prisma.employees.findUnique({
      where: { id }
    });

    if (!employee) {
      return res.status(404).json({ error: 'Employee tidak ditemukan' });
    }

    // Delete related records first (foreign key constraints)
    // Delete leave requests
    await prisma.leave_requests.deleteMany({
      where: { employee_id: id }
    });

    // Delete attendance records
    await prisma.attendance_records.deleteMany({
      where: { employee_id: id }
    });

    // Delete izin_sakit records
    await prisma.izin_sakit.deleteMany({
      where: { employee_id: id }
    });

    // Delete payroll records
    await prisma.payrolls.deleteMany({
      where: { employee_id: id }
    });

    // Delete leave quotas
    await prisma.leave_quotas.deleteMany({
      where: { employee_id: id }
    });

    // Finally delete the employee
    await prisma.employees.delete({
      where: { id }
    });

    res.status(200).json({ message: 'Employee berhasil dihapus' });
  } catch (err) {
    console.error('Error deleting employee:', err);
    res.status(500).json({ error: 'Gagal menghapus karyawan' });
  }
});

// Validasi untuk update employee
app.put('/api/employees/:id', async (req, res) => {
  const idSchema = z.string().uuid();
  const employeeUpdateSchema = z.object({
    first_name: z.string().min(1).optional(),
    last_name: z.string().min(1).optional(),
    email: z.string().email().optional(),
    phone_number: z.string().min(10).max(13).optional(),
    position: z.string().min(1).optional(),
    hire_date: z.string().min(1).optional(),
    date_of_birth: z.string().min(1).optional(),
    address: z.string().min(1).optional(),
    bank_account_number: z.string().min(9).max(17).optional(),
    bank_name: z.string().min(1).optional(),
    user_id: z.string().uuid().optional(),
    departemen_id: z.string().uuid().optional(),
    nik: z.string().optional()
  });
  if (!idSchema.safeParse(req.params.id).success) {
    return res.status(400).json({ error: 'ID tidak valid' });
  }
  const parseResult = employeeUpdateSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Data update karyawan tidak valid', details: parseResult.error.errors });
  }
  try {
    const { id } = req.params;
    const updateData = { ...parseResult.data };
    if (updateData.hire_date && typeof updateData.hire_date === 'string' && !updateData.hire_date.includes('T')) {
      updateData.hire_date = new Date(updateData.hire_date).toISOString();
    }
    if (updateData.date_of_birth && typeof updateData.date_of_birth === 'string' && !updateData.date_of_birth.includes('T')) {
      updateData.date_of_birth = new Date(updateData.date_of_birth).toISOString();
    }
    const employee = await prisma.employees.update({
      where: { id },
      data: updateData
    });
    res.json(employee);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: errorMsg });
  }
});

app.delete('/api/employees/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.employees.delete({ where: { id } });
    res.json({ message: 'Employee deleted' });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: errorMsg });
  }
});

// === Leave Requests Endpoints ===
app.get('/api/leave-requests', async (req, res) => {
  try {
    let where: any = {};
    // PATCH: Best practice - jika ada user_id, SELALU filter ke employee_id user tsb
    const user_id = req.query.user_id || req.headers['x-user-id'];
    if (user_id) {
      // Mapping user_id ke employee_id
      const employee = await prisma.employees.findFirst({ where: { user_id: Array.isArray(user_id) ? user_id[0] : user_id } });
      if (!employee) return res.json([]); // Tidak ditemukan, return kosong
      where.employee_id = employee.id;
    } else if (req.query.employee_id) {
      // Pastikan employee_id adalah string
      let employee_id = req.query.employee_id;
      if (Array.isArray(employee_id)) employee_id = employee_id[0];
      where.employee_id = employee_id;
    }
    if (req.query.status) {
      where.status = req.query.status;
    }
    // Selalu include employee dengan departemen dan approvedByUser/rejectedByUser
    const leaveRequests = await prisma.leave_requests.findMany({ 
      where, 
      include: { 
        employee: {
          include: {
            departemen: true
          }
        }, 
        approvedByUser: true, 
        rejectedByUser: true 
      },
      orderBy: { created_at: 'desc' }
    });
    res.json(leaveRequests);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: errorMsg });
  }
});

// Endpoint untuk notifikasi cuti yang ditolak
app.get('/api/notifications/rejected-leaves', async (req, res) => {
  try {
    const user_id = req.query.user_id || req.headers['x-user-id'];
    
    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const employee = await prisma.employees.findFirst({ 
      where: { user_id: Array.isArray(user_id) ? user_id[0] : user_id } 
    });
    
    if (!employee) {
      return res.json([]);
    }

    // Fetch both APPROVED and REJECTED leave requests
    const leaveRequests = await prisma.leave_requests.findMany({
      where: {
        employee_id: employee.id,
        status: { in: ['APPROVED', 'REJECTED'] }
      },
      include: {
        employee: true,
        approvedByUser: true,
        rejectedByUser: true
      },
      orderBy: { created_at: 'desc' }
    });

    // Fetch both APPROVED and REJECTED izin_sakit requests
    const izinRequests = await prisma.izin_sakit.findMany({
      where: {
        employee_id: employee.id,
        status: { in: ['APPROVED', 'REJECTED'] }
      },
      orderBy: { created_at: 'desc' }
    });

    // Combine and format data
    const allRequests = [
      ...leaveRequests.map(req => ({
        ...req,
        request_type: 'leave',
        leave_type: req.leave_type || 'Cuti'
      })),
      ...izinRequests.map(req => ({
        ...req,
        request_type: 'izin_sakit',
        leave_type: req.jenis || 'Izin/Sakit',
        employee: { first_name: 'Karyawan' }, // Placeholder since izin_sakit doesn't have employee relation
        reason: req.alasan || 'Tidak ada alasan',
        start_date: req.tanggal || req.created_at,
        end_date: req.tanggal || req.created_at,
        approvedByUser: { first_name: 'HRD' }, // Placeholder
        rejectedByUser: { first_name: 'HRD' } // Placeholder
      }))
    ];

    // Sort by created_at desc
    allRequests.sort((a, b) => {
      const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
      const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
      return dateB - dateA;
    });

    res.json(allRequests);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Internal server error';
    console.error('Error in rejected-leaves endpoint:', errorMsg);
    res.status(500).json({ error: errorMsg });
  }
});

// Endpoint khusus untuk HRD - semua pengajuan PENDING
app.get('/api/notifications/hrd-pending', async (req, res) => {
  try {
    // Fetch pending leave requests
    const pendingLeaveRequests = await prisma.leave_requests.findMany({
      where: {
        status: 'PENDING'
      },
      include: {
        employee: true,
        approvedByUser: true,
        rejectedByUser: true
      },
      orderBy: { created_at: 'desc' }
    });

    // Fetch pending izin_sakit requests
    const pendingIzinRequests = await prisma.izin_sakit.findMany({
      where: {
        status: 'PENDING'
      },
      include: {
        employee: true // Include employee relation if exists
      },
      orderBy: { created_at: 'desc' }
    });

    // Combine and format data
    const allPendingRequests = [
      ...pendingLeaveRequests.map(req => ({
        ...req,
        request_type: 'leave',
        leave_type: req.leave_type || 'Cuti'
      })),
      ...pendingIzinRequests.map(req => {
        return {
          ...req,
          request_type: 'izin_sakit',
          leave_type: req.jenis || 'Izin/Sakit', // Use jenis field from database
          employee: req.employee || { first_name: 'Karyawan' }, // Use actual employee data if available
          reason: req.alasan || 'Tidak ada alasan', // Use alasan field from database
          start_date: req.tanggal || req.created_at, // Use tanggal field if available
          end_date: req.tanggal || req.created_at // Use tanggal field if available
        };
      })
    ];

    // Sort by created_at desc
    allPendingRequests.sort((a, b) => {
      const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
      const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
      return dateB - dateA;
    });
    
    res.json(allPendingRequests);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Internal server error';
    console.error('Error in hrd-pending endpoint:', errorMsg);
    res.status(500).json({ error: errorMsg });
  }
});

// Endpoint test untuk melihat semua leave requests
app.get('/api/test/leave-requests', async (req, res) => {
  try {
    const allRequests = await prisma.leave_requests.findMany({
      include: {
        employee: true,
        rejectedByUser: true
      },
      orderBy: { created_at: 'desc' }
    });
    res.json(allRequests);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: errorMsg });
  }
});

// Endpoint untuk menandai notifikasi sebagai dibaca
app.post('/api/notifications/mark-read', async (req, res) => {
  try {
    const { user_id, notification_id } = req.body;
    
    if (!user_id || !notification_id) {
      return res.status(400).json({ error: 'user_id dan notification_id required' });
    }

    // Simpan ke database bahwa notifikasi sudah dibaca
    // Untuk sementara kita simpan di memory, nanti bisa ditambahkan tabel notifications_read
    console.log(`Marking notification ${notification_id} as read for user ${user_id}`);
    
    res.json({ success: true, message: 'Notification marked as read' });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: errorMsg });
  }
});

// Validasi untuk leave request POST
app.post('/api/leave-requests', async (req, res) => {
  const leaveRequestSchema = z.object({
    user_id: z.string().uuid().optional(),
    leave_type: z.string().min(1),
    start_date: z.string().min(1),
    end_date: z.string().min(1),
    reason: z.string().min(1),
    status: z.string().optional(),
    notes: z.string().optional(),
    requested_date: z.string().optional(),
    approved_by: z.string().uuid().optional(),
    rejection_reason: z.string().optional(),
    rejected_by: z.string().uuid().optional(),
    rejected_at: z.string().optional()
  });
  const parseResult = leaveRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Data cuti tidak valid', details: parseResult.error.errors });
  }
  try {
    const { leave_type, start_date, end_date, reason, user_id } = parseResult.data;
    // Validasi tanggal ISO dan urutan
    const start = new Date(start_date);
    const end = new Date(end_date);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ error: 'Format tanggal tidak valid (harus ISO-8601)' });
    }
    if (start > end) {
      return res.status(400).json({ error: 'Tanggal mulai tidak boleh setelah tanggal selesai.' });
    }
    // Ambil user_id dari body atau header (disesuaikan dengan autentikasi Anda)
    let uid = user_id || req.headers['x-user-id'];
    if (Array.isArray(uid)) uid = uid[0];
    if (!uid || typeof uid !== 'string') return res.status(400).json({ error: 'user_id is required' });
    // Cari employee_id dari tabel employees
    const employee = await prisma.employees.findFirst({ where: { user_id: uid } });
    if (!employee) {
      console.error('[LEAVE REQUEST] Tidak ditemukan employee untuk user_id:', uid);
      return res.status(404).json({ error: 'Mapping user_id ke employee_id gagal. Data karyawan tidak ditemukan untuk user ini. Pastikan user sudah punya data karyawan.' });
    }
    // Validasi tanggal mulai tidak boleh sebelum hari ini (WIB)
    const nowWIB = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    const todayWIB = new Date(nowWIB.getFullYear(), nowWIB.getMonth(), nowWIB.getDate());
    if (start < todayWIB) {
      return res.status(400).json({ error: 'Tanggal mulai tidak boleh sebelum hari ini.' });
    }
    // Cek overlap pengajuan cuti (PENDING/APPROVED)
    const overlap = await prisma.leave_requests.findFirst({
      where: {
        employee_id: employee.id,
        status: { in: ['PENDING', 'APPROVED'] },
        OR: [
          {
            start_date: { lte: end.toISOString() },
            end_date: { gte: start.toISOString() }
          }
        ]
      }
    });
    if (overlap) {
      return res.status(400).json({ error: 'Sudah ada pengajuan cuti di tanggal tersebut.' });
    }
    // Jika quota habis, hanya izinkan cuti Sakit/selain Tahunan
    const year = start.getFullYear();
    const quota = await prisma.leave_quotas.findFirst({ where: { employee_id: employee.id, year, quota_type: 'tahunan' } });
    // Hitung jumlah hari cuti
    const days = Math.ceil((end.getTime() - start.getTime()) / (1000*60*60*24)) + 1;
    if (quota && quota.total_quota - quota.used_quota < days && leave_type.toLowerCase() === 'tahunan') {
      return res.status(400).json({ error: 'Quota cuti tahunan tidak mencukupi.' });
    }
    // Buat leave request
    // Hanya ambil field yang ada di tabel dan field wajib
    const payload = {
      employee_id: employee.id,
      leave_type,
      start_date: start.toISOString(),
      end_date: end.toISOString(),
      reason,
      status: parseResult.data.status,
      ...(parseResult.data.requested_date && { requested_date: parseResult.data.requested_date }),
      ...(parseResult.data.approved_by && { approved_by: parseResult.data.approved_by }),
      ...(parseResult.data.rejection_reason && { rejection_reason: parseResult.data.rejection_reason }),
      ...(parseResult.data.rejected_by && { rejected_by: parseResult.data.rejected_by }),
      ...(parseResult.data.rejected_at && { rejected_at: parseResult.data.rejected_at })
    };
    // Pastikan tidak ada user_id di payload
    // @ts-ignore
    delete payload.user_id;
    const leaveRequest = await prisma.leave_requests.create({ data: payload });
    // PATCH: Tidak update quota di sini! (Quota hanya dikurangi saat APPROVED di PUT)
    res.status(201).json(leaveRequest);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: errorMsg });
  }
});

// Validasi untuk update leave request
app.put('/api/leave-requests/:id', async (req, res) => {
  const idSchema = z.string().uuid();
  const leaveRequestUpdateSchema = z.object({
    status: z.string().optional(),
    approver_id: z.string().uuid().optional(),
    rejector_id: z.string().uuid().optional(),
    notes: z.string().optional(),
    rejection_reason: z.string().optional(),
    approved_by: z.string().uuid().optional(),
    rejected_by: z.string().uuid().optional(),
    rejected_at: z.string().optional()
  });
  if (!idSchema.safeParse(req.params.id).success) {
    return res.status(400).json({ error: 'ID tidak valid' });
  }
  const parseResult = leaveRequestUpdateSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Data update cuti tidak valid', details: parseResult.error.errors });
  }
  try {
    const { id } = req.params;
    const updateData = { ...req.body };
    // Ambil leave request lama
    const oldRequest = await prisma.leave_requests.findUnique({ where: { id } });
    if (!oldRequest) throw new Error('Leave request not found');
    // Jika approve, simpan approved_by
    if (updateData.status === 'APPROVED' && !updateData.approved_by) {
      updateData.approved_by = req.body.approver_id || req.headers['x-user-id'] || null;
    }
    // Jika reject, simpan rejected_by
    if (updateData.status === 'REJECTED' && !updateData.rejected_by) {
      updateData.rejected_by = req.body.rejector_id || req.headers['x-user-id'] || null;
      updateData.rejected_at = new Date().toISOString();
    }
    // Filter hanya field yang boleh diupdate
    const allowedFields = [
      'status', 'approved_by', 'rejected_by', 'rejection_reason', 'rejected_at', 'notes'
    ];
    const filteredUpdateData = Object.fromEntries(
      Object.entries(updateData).filter(([key, value]) => allowedFields.includes(key) && value !== undefined)
    );
    // Update kolom approved_by/rejected_by jika perlu
    if (updateData.status === 'APPROVED' && !filteredUpdateData.approved_by) {
      filteredUpdateData.approved_by = req.body.approver_id || req.headers['x-user-id'] || null;
    }
    if (updateData.status === 'REJECTED' && !filteredUpdateData.rejected_by) {
      filteredUpdateData.rejected_by = req.body.rejector_id || req.headers['x-user-id'] || null;
      filteredUpdateData.rejected_at = new Date().toISOString();
    }
    // Validasi UUID
    if (typeof filteredUpdateData.approved_by === 'string' && filteredUpdateData.approved_by && !/^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/.test(filteredUpdateData.approved_by)) {
      return res.status(400).json({ error: 'approved_by harus UUID' });
    }
    if (typeof filteredUpdateData.rejected_by === 'string' && filteredUpdateData.rejected_by && !/^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/.test(filteredUpdateData.rejected_by)) {
      return res.status(400).json({ error: 'rejected_by harus UUID' });
    }
    // Update leave request
    const leaveRequest = await prisma.leave_requests.update({
      where: { id },
      data: filteredUpdateData
    });
    // Jika status berubah jadi APPROVED dan reason bukan Sakit, update used_quota
    if (updateData.status === 'APPROVED' && oldRequest.status !== 'APPROVED' && oldRequest.reason !== 'Sakit') {
      // Hitung jumlah hari cuti
      const start = new Date(oldRequest.start_date);
      const end = new Date(oldRequest.end_date);
      const duration = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
      // Ambil tahun dan quota_type
      const year = start.getFullYear();
      const quota_type = 'tahunan'; // Bisa dikembangkan sesuai leave_type
      // Cari leave_quota record
      const leaveQuota = await prisma.leave_quotas.findFirst({
        where: { employee_id: oldRequest.employee_id, year: year, quota_type: quota_type }
      });
      if (leaveQuota) {
        // Update used_quota
        const newUsed = (leaveQuota.used_quota || 0) + duration;
        await prisma.leave_quotas.update({
          where: { id: leaveQuota.id },
          data: { used_quota: newUsed, updated_at: new Date().toISOString() }
        });
      }
    }
    res.json(leaveRequest);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: errorMsg });
  }
});

app.delete('/api/leave-requests/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.leave_requests.delete({ where: { id } });
    res.json({ message: 'Leave request deleted' });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: errorMsg });
  }
});

// === Leave Quotas Endpoints ===
// GET: List/filter leave quotas (HRD)
app.get('/api/leave-quotas', async (req, res) => {
  try {
    let where: any = {};
    if (req.query.employee_id) {
      const employee_id = Array.isArray(req.query.employee_id) ? req.query.employee_id[0] : req.query.employee_id as string;
      where.employee_id = employee_id;
    }
    if (req.query.year) {
      const year = Array.isArray(req.query.year) ? req.query.year[0] : req.query.year as string;
      where.year = parseInt(year as string, 10);
    }
    if (req.query.quota_type) {
      where.quota_type = req.query.quota_type as string;
    }
    const leaveQuotas = await prisma.leave_quotas.findMany({ 
      where,
      include: {
        employee: {
          include: {
            departemen: true
          }
        }
      }
    });
    res.json(leaveQuotas);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: errorMsg });
  }
});

// Validasi untuk leave quota POST
app.post('/api/leave-quotas', async (req, res) => {
  const leaveQuotaSchema = z.object({
    employee_id: z.string().uuid(),
    quota_type: z.string().min(1),
    year: z.number().int(),
    total_quota: z.number().int().nonnegative()
  });
  const parseResult = leaveQuotaSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Data kuota cuti tidak valid', details: parseResult.error.errors });
  }
  try {
    const { employee_id, quota_type = 'tahunan', year, total_quota } = req.body;
    if (!employee_id || !year || !total_quota) {
      return res.status(400).json({ error: 'employee_id, year, dan total_quota wajib diisi' });
    }
    const leaveQuota = await prisma.leave_quotas.create({
      data: req.body
    });
    res.status(201).json(leaveQuota);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: errorMsg });
  }
});

// PUT: Edit leave quota (HRD)
app.put('/api/leave-quotas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const leaveQuota = await prisma.leave_quotas.update({
      where: { id: Number(id) },
      data: req.body
    });
    res.json(leaveQuota);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: errorMsg });
  }
});

// GET: Karyawan lihat sisa cuti sendiri
app.get('/api/leave-quotas/me', async (req, res) => {
  try {
    // Ambil user_id dari query atau header (disesuaikan dengan autentikasi Anda)
    const user_id = req.query.user_id || req.headers['x-user-id'];
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });
    
    // Pastikan user_id adalah string
    const user_id_str = Array.isArray(user_id) ? user_id[0] : user_id as string;
    
    // Cari employee_id dari tabel employees
    const employee = await prisma.employees.findFirst({ where: { user_id: user_id_str } });
    if (!employee) return res.status(404).json({ error: 'Employee not found' });
    
    let where: any = {};
    where.employee_id = employee.id;
    if (req.query.year) {
      const year = Array.isArray(req.query.year) ? req.query.year[0] : req.query.year as string;
      where.year = parseInt(year as string, 10);
    }
    if (req.query.quota_type) {
      where.quota_type = req.query.quota_type as string;
    }
    const leaveQuotas = await prisma.leave_quotas.findMany({ where });
    res.json(leaveQuotas);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: errorMsg });
  }
});

// PATCH: Tambahkan endpoint DELETE leave quota
app.delete('/api/leave-quotas/:id', async (req, res) => {
  try {
    const idNum = parseInt(req.params.id, 10);
    if (isNaN(idNum)) return res.status(400).json({ error: 'ID harus berupa angka' });
    await prisma.leave_quotas.delete({ where: { id: idNum } });
    res.json({ message: 'Leave quota deleted' });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: errorMsg });
  }
});

// === Users Endpoints ===
app.get('/api/users', async (req, res) => {
  try {
    const users = await prisma.users.findMany();
    res.json(users);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: errorMsg });
  }
});

app.get('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const user = await prisma.users.findUnique({ where: { id } });
    if (!user) throw new Error('User not found');
    res.json(user);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: errorMsg });
  }
});

app.put('/api/users/:id/last-login', async (req, res) => {
  try {
    const { id } = req.params;
    const user = await prisma.users.update({
      where: { id },
      data: { last_login: new Date().toISOString() }
    });
    res.json(user);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: errorMsg });
  }
});

// Validasi untuk update user
app.put('/api/users/:id', async (req, res) => {
  const idSchema = z.string().uuid();
  const userUpdateSchema = z.object({
    email: z.string().email().optional(),
    username: z.string().min(1).optional(),
    role: z.string().min(1).optional(),
    password: z.string().min(6).optional()
  });
  if (!idSchema.safeParse(req.params.id).success) {
    return res.status(400).json({ error: 'ID tidak valid' });
  }
  const parseResult = userUpdateSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Data update user tidak valid', details: parseResult.error.errors });
  }
  try {
    const { id } = req.params;
    const { email, username, role, password } = req.body;
    
    // Jika ada password, hash password baru
    let updateData: any = {};
    if (email) updateData.email = email;
    if (username) updateData.username = username;
    if (role) updateData.role = role;
    if (password) {
      const hashedPassword = await new Argon2id().hash(password);
      updateData.encrypted_password = hashedPassword;
    }
    
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'Tidak ada data yang diupdate.' });
    }
    
    const user = await prisma.users.update({
      where: { id },
      data: updateData
    });
    res.json(user);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: errorMsg });
  }
});

// === Tambahkan endpoint DELETE user ===
app.delete('/api/users/:id', async (req, res) => {
  const idSchema = z.string().uuid();
  if (!idSchema.safeParse(req.params.id).success) {
    return res.status(400).json({ error: 'ID tidak valid' });
  }
  try {
    const { id } = req.params;
    // Hapus relasi employee jika ada (optional, tergantung kebutuhan)
    // await prisma.employees.deleteMany({ where: { user_id: id } });
    // Hapus user
    const deleted = await prisma.users.delete({ where: { id } });
    res.json({ message: 'User berhasil dihapus', user: deleted });
  } catch (err) {
    const error: any = err;
    if (error.code === 'P2025' || (error.message && error.message.includes('No')) || (error.message && error.message.includes('not found'))) {
      return res.status(404).json({ error: 'User tidak ditemukan' });
    }
    const errorMsg = error instanceof Error ? error.message : 'Internal server error';
    res.status(500).json({ error: errorMsg });
  }
});

app.post('/api/auth/register', async (req, res) => {
  const registerSchema = z.object({
    name: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(6)
  });
  const parseResult = registerSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Data registrasi tidak valid', details: parseResult.error.errors });
  }
  const { name, email, password } = parseResult.data;
  try {
    // Cek email sudah terdaftar
    const existing = await prisma.users.findFirst({ where: { email } });
    if (existing) return res.status(400).json({ error: 'Email sudah terdaftar' });
    // Hash password
    const hashedPassword = await new Argon2id().hash(password);
    // Simpan user baru
    const user = await prisma.users.create({
      data: {
        email,
        encrypted_password: hashedPassword,
        role: 'karyawan', // default role
        username: name // atau 'name' jika field di DB
      }
    });
    res.status(201).json({ message: 'Registrasi berhasil', user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/users/bulk', async (req, res) => {
  const users = req.body;
  if (!Array.isArray(users)) {
    return res.status(400).json({ error: 'Payload harus berupa array user.' });
  }
  const results = [];
  for (const user of users) {
    // Validasi field wajib
    if (!user.username || !user.email || !user.password || !user.role) {
      results.push({ success: false, user, error: 'Field username, email, password, role wajib diisi.' });
      continue;
    }
    // Validasi email unik
    const existing = await prisma.users.findUnique({ where: { email: user.email } });
    if (existing) {
      results.push({ success: false, user, error: 'Email sudah terdaftar.' });
      continue;
    }
    // Hash password (gunakan Argon2id, konsisten dengan seluruh app)
    const hashedPassword = await new Argon2id().hash(user.password);
    try {
      const created = await prisma.users.create({
        data: {
          username: user.username,
          email: user.email,
          encrypted_password: hashedPassword, // sesuai schema.prisma
          role: user.role.toLowerCase(),
        },
      });
      results.push({ success: true, user: created });
    } catch (err) {
      results.push({ success: false, user, error: err instanceof Error ? err.message : String(err) });
    }
  }
  // Jika ada error, return detail
  const failed = results.filter(r => !r.success);
  if (failed.length > 0) {
    return res.status(400).json({ error: 'Beberapa user gagal ditambahkan', results });
  }
  res.json({ success: true, results });
});

app.post('/api/employees/bulk', async (req, res) => {
  const employees = req.body;
  if (!Array.isArray(employees)) {
    return res.status(400).json({ error: 'Payload harus berupa array employee.' });
  }
  const results = [];
  for (const emp of employees) {
    // Helper: parse beberapa format tanggal (YYYY-MM-DD atau DD/MM/YYYY)
    const parseFlexibleDate = (val: any): Date | undefined => {
      if (val === null || val === undefined) return undefined;
      const raw = String(val).trim();
      if (raw === '') return undefined;
      // DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY
      const dmy = raw.match(/^([0-3]?\d)[\/\.\-]([0-1]?\d)[\/\.\-](\d{4})$/);
      if (dmy) {
        const dd = Number(dmy[1]);
        const mm = Number(dmy[2]) - 1; // zero-based
        const yyyy = Number(dmy[3]);
        const d = new Date(yyyy, mm, dd);
        return isNaN(d.getTime()) ? undefined : d;
      }
      // YYYY-MM-DD
      const ymd = raw.match(/^(\d{4})-([0-1]?\d)-([0-3]?\d)$/);
      if (ymd) {
        const yyyy = Number(ymd[1]);
        const mm = Number(ymd[2]) - 1;
        const dd = Number(ymd[3]);
        const d = new Date(yyyy, mm, dd);
        return isNaN(d.getTime()) ? undefined : d;
      }
      // Fallback: biarkan Date men-parse bila format lain masih valid
      const d = new Date(raw);
      return isNaN(d.getTime()) ? undefined : d;
    };
    // Validasi kolom wajib
    if (!emp.first_name || !emp.email || !emp.phone_number || !emp.position) {
      results.push({ success: false, emp, error: 'Kolom wajib: first_name, email, phone_number, position.' });
      continue;
    }
    // PATCH: hire_date tidak wajib, validasi hanya jika ada isinya (dukung DD/MM/YYYY)
    const hireDateObj = parseFlexibleDate(emp.hire_date);
    if (emp.hire_date && !hireDateObj) {
      results.push({ success: false, emp, error: 'Format hire_date tidak valid (YYYY-MM-DD atau DD/MM/YYYY).'});
      continue;
    }
    // Cari user berdasarkan email
    const user = await prisma.users.findFirst({ where: { email: emp.email } });
    if (!user) {
      results.push({ success: false, emp, error: 'User dengan email ini belum terdaftar di tabel users.' });
      continue;
    }
    // Cek apakah sudah ada employee dengan user_id/email ini
    const existingEmployee = await prisma.employees.findFirst({
      where: {
        OR: [
          { user_id: user.id },
          { email: emp.email }
        ]
      }
    });
    if (existingEmployee) {
      results.push({ success: false, emp, error: 'Karyawan dengan email/user ini sudah terdaftar.' });
      continue;
    }
    // Build data employee tanpa field undefined/null
    const dateOfBirthObj = parseFlexibleDate(emp.date_of_birth);
    if (emp.date_of_birth && !dateOfBirthObj) {
      results.push({ success: false, emp, error: 'Format date_of_birth tidak valid (YYYY-MM-DD atau DD/MM/YYYY).'});
      continue;
    }

    // Tentukan departemen_id berdasarkan nama departemen di CSV (jika ada)
    let departemenId: string | undefined = undefined;
    try {
      const departments = await prisma.departemen.findMany();
      if (emp.department) {
        const target = String(emp.department).trim().toLowerCase();
        const found = departments.find(d => d.nama.trim().toLowerCase() === target);
        if (found) departemenId = found.id;
      }
      if (!departemenId && departments.length > 0) {
        departemenId = departments[0].id; // fallback
      }
    } catch {}

    // NIK: fleksibel sesuai permintaan
    // - Jika CSV mengisi nik (apa pun isinya), terima apa adanya (trim)
    // - Jika kosong: coba generate dari config departemen; jika tidak ada config, pakai default EMP + timestamp
    let nikVal: string | undefined = undefined;
    if (emp.nik !== undefined && emp.nik !== null && String(emp.nik).trim() !== '') {
      nikVal = String(emp.nik).trim();
    } else if (departemenId) {
      const nikCfg = await prisma.department_nik_config.findFirst({ where: { department_id: departemenId, is_active: true } });
      if (nikCfg) {
        const seq = String(nikCfg.current_sequence).padStart(nikCfg.sequence_length, '0');
        nikVal = nikCfg.format_pattern && nikCfg.format_pattern.includes('{prefix}') && nikCfg.format_pattern.includes('{sequence}')
          ? nikCfg.format_pattern.replace('{prefix}', nikCfg.prefix).replace('{sequence}', seq)
          : `${nikCfg.prefix}${seq}`;
        await prisma.department_nik_config.update({ where: { id: nikCfg.id }, data: { current_sequence: nikCfg.current_sequence + 1 } });
      } else {
        nikVal = `EMP${Date.now().toString().slice(-6)}`;
      }
    } else {
      nikVal = `EMP${Date.now().toString().slice(-6)}`;
    }

    const employeeData = Object.fromEntries(Object.entries({
      first_name: emp.first_name,
      last_name: emp.last_name || '',
      email: emp.email,
      phone_number: emp.phone_number,
      position: emp.position,
      hire_date: hireDateObj, // PATCH: boleh undefined/null
      bank_account_number: emp.bank_account_number || '',
      address: emp.address || '',
      date_of_birth: dateOfBirthObj,
      departemen_id: departemenId,
      nik: nikVal,
      bank_name: emp.bank_name || undefined,
      user_id: user.id
    }).filter(([_, v]) => v !== undefined && v !== null));
    try {
      let created;
      try {
        created = await prisma.employees.create({ data: employeeData as any });
      } catch (e: any) {
        // fallback jika unik bentrok saja
        const msg = String(e?.message || '').toLowerCase();
        if (msg.includes('unique') && (employeeData as any)?.nik) {
          (employeeData as any).nik = `EMP${Date.now().toString().slice(-8)}`;
          created = await prisma.employees.create({ data: employeeData as any });
        } else {
          throw e;
        }
      }
      // Update employee_id di tabel users
      await prisma.users.update({ where: { id: user.id }, data: { employee_id: created.id } });
      results.push({ success: true, emp: created });
    } catch (err) {
      results.push({ success: false, emp, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const failed = results.filter(r => !r.success);
  if (failed.length > 0) {
    return res.status(400).json({ error: 'Beberapa data gagal ditambahkan', results });
  }
  res.json({ success: true, results });
});

app.get('/api/me', async (req, res) => {
  try {
    // Ambil session id dari cookie
    const sessionId = req.cookies['auth_session'];
    if (!sessionId) return res.status(401).json({ error: 'Unauthorized' });
    // Cari session di database
    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || !session.user_id) return res.status(401).json({ error: 'Unauthorized' });
    // Cari user dari session
    const user = await prisma.users.findUnique({ where: { id: session.user_id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user: { id: user.id, email: user.email, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH: Tambahkan endpoint untuk mendapatkan role user
app.get('/api/user-role', async (req, res) => {
  let userId = req.query.user_id || req.query.userId;
  if (Array.isArray(userId)) userId = userId[0];
  if (typeof userId !== 'string' || !userId) return res.status(400).json({ error: 'user_id is required' });
  const user = await prisma.users.findUnique({ where: { id: userId } });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ role: user.role });
});

// PATCH: Endpoint admin-create-user
app.post('/api/admin-create-user', async (req, res) => {
  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  const authHeader = req.headers['authorization'];
  if (!ADMIN_SECRET) {
    return res.status(500).json({ error: 'Admin secret tidak terkonfigurasi' });
  }
  if (!authHeader || authHeader !== `Bearer ${ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const userSchema = z.object({
    username: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(6),
    role: z.string().min(1)
  });
  const parseResult = userSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Data user tidak valid', details: parseResult.error.errors });
  }
  const { username, email, password, role } = parseResult.data;
  try {
    // Cek email sudah terdaftar
    const existing = await prisma.users.findFirst({ where: { email } });
    if (existing) return res.status(400).json({ error: 'Email sudah terdaftar' });
    // Hash password
    const hashedPassword = await new Argon2id().hash(password);
    // Simpan user baru
    const user = await prisma.users.create({
      data: {
        email,
        encrypted_password: hashedPassword,
        role,
        username
      }
    });
    res.status(201).json({ message: 'User berhasil dibuat', user: { id: user.id, email: user.email, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH: Endpoint GET /api/system-settings
app.get('/api/system-settings', async (req, res) => {
  try {
    const settings = await prisma.system_settings.findMany();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// === Attendance Endpoints ===
// HAPUS: app.post('/api/attendance/clock-in', ... )
// HAPUS: app.post('/api/attendance/clock-out', ... )

// === Attendance Records GET Endpoint ===
app.get('/api/attendance-records', async (req, res) => {
  try {
    const { employee_id, date } = req.query;
    let where = {};
    if (employee_id) {
      where = { ...where, employee_id: String(employee_id) };
    }
    if (date) {
      // date bisa string ISO atau YYYY-MM-DD
      const dateOnly = String(date).length > 10 ? String(date).slice(0, 10) : String(date);
      where = { ...where, date: new Date(dateOnly) };
    }
    if (employee_id && date) {
      // Return satu record (absensi hari ini)
      const record = await prisma.attendance_records.findFirst({ where, include: { employee: true } });
      return res.json(record);
    } else if (employee_id) {
      // Return semua absensi karyawan
      const records = await prisma.attendance_records.findMany({ where, include: { employee: true } });
      return res.json(records);
    } else {
      // Return semua absensi
      const records = await prisma.attendance_records.findMany({ include: { employee: true } });
      return res.json(records);
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: errorMsg });
  }
});

// === Payroll Components Endpoints ===
app.get('/api/payroll-components', async (req, res) => {
  try {
    console.log('Fetching payroll components...');
    
    const components = await prisma.payroll_components.findMany({
      where: { is_active: true },
      orderBy: [
        { type: 'asc' },
        { category: 'asc' },
        { name: 'asc' }
      ]
    });
    
    console.log(`Found ${components.length} active payroll components`);
    res.json(components);
  } catch (error) {
    console.error('Error fetching payroll components:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// === HR Pending Endpoint ===
app.get('/api/hr-pending', async (req, res) => {
  try {
    console.log('Fetching HR pending data...');
    
    // Return empty array for now (bisa diisi sesuai kebutuhan)
    res.json([]);
  } catch (error) {
    console.error('Error fetching HR pending data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// === Payroll Endpoints ===
const payrollSchema = z.object({
  employee_id: z.string().uuid(),
  pay_period_start: z.string().min(1), // ISO date
  pay_period_end: z.string().min(1),   // ISO date
  basic_salary: z.number().optional(),
  gross_salary: z.number(),
  net_salary: z.number(),
  payment_date: z.string().min(1),     // ISO date
  status: z.string().min(1),
  
  // Tunjangan dari Data Salary
  position_allowance: z.number().optional(),
  management_allowance: z.number().optional(),
  phone_allowance: z.number().optional(),
  incentive_allowance: z.number().optional(),
  overtime_allowance: z.number().optional(),
  total_allowances: z.number().optional(),
  
  // Komponen Payroll yang Dihitung - Perusahaan (PENDAPATAN TETAP)
  bpjs_health_company: z.number().optional(),
  jht_company: z.number().optional(),
  jkk_company: z.number().optional(),
  jkm_company: z.number().optional(),
  jp_company: z.number().optional(),
  subtotal_company: z.number().optional(),
  
  // Komponen Payroll yang Dihitung - Karyawan (POTONGAN)
  bpjs_health_employee: z.number().optional(),
  jht_employee: z.number().optional(),
  jp_employee: z.number().optional(),
  subtotal_employee: z.number().optional(),
  
  // Deductions Manual
  kasbon: z.number().optional(),
  telat: z.number().optional(),
  angsuran_kredit: z.number().optional(),
  
  // Total Deductions
  total_deductions: z.number().optional(),
  
  // Total Pendapatan (Gaji + Tunjangan + BPJS Perusahaan)
  total_pendapatan: z.number().optional(),
  
  // Additional fields untuk database schema
  bpjs_employee: z.number().optional(),
  bpjs_company: z.number().optional(),
  jkk: z.number().optional(),
  jkm: z.number().optional(),
  deductions: z.number().optional(),
  
  // Additional fields
  created_by: z.string().uuid().optional(),
  approved_by: z.string().uuid().optional(),
  approved_at: z.string().optional()
});

// GET all payrolls
app.get('/api/payrolls', async (req, res) => {
  try {
    console.log('Fetching payrolls...');
    
    // Build where clause based on query parameters
    let where: any = {};
    
    // Filter by employee_id if provided (for employee dashboard)
    if (req.query.employee_id) {
      const employee_id = Array.isArray(req.query.employee_id) 
        ? req.query.employee_id[0] 
        : req.query.employee_id as string;
      where.employee_id = employee_id;
      console.log(`Filtering payrolls for employee_id: ${employee_id}`);
    }
    
    // Additional filters can be added here (status, date range, etc.)
    if (req.query.status) {
      where.status = req.query.status as string;
    }
    
    // Cek apakah tabel payrolls ada
    try {
      const payrolls = await prisma.payrolls.findMany({ 
        where,
        include: { 
          employee: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
              email: true,
              position: true
            }
          } 
        },
        orderBy: {
          payment_date: 'desc'
        }
      });
      
      console.log(`Found ${payrolls.length} payrolls`);
      
      // Pastikan payrolls selalu array, dan jika employee null, tetap return payroll
      const safePayrolls = payrolls.map(p => ({ 
        ...p, 
        employee: p.employee || null 
      }));
      
      res.json(safePayrolls);
    } catch (tableError) {
      console.error('Table payrolls error:', tableError);
      // Jika tabel belum ada, return array kosong
      res.json([]);
    }
  } catch (err) {
    console.error('Error in /api/payrolls:', err);
    res.status(500).json({ 
      error: 'Internal server error',
      details: err instanceof Error ? err.message : 'Unknown error'
    });
  }
});

// GET payroll by id
app.get('/api/payrolls/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get employee_id from query parameter if provided (for security check)
    const requestingEmployeeId = req.query.employee_id as string | undefined;
    
    const payroll = await prisma.payrolls.findUnique({ 
      where: { id }, 
      include: { employee: true } 
    });
    
    if (!payroll) return res.status(404).json({ error: 'Payroll not found' });
    
    // If employee_id is provided, ensure they can only access their own payroll
    if (requestingEmployeeId && payroll.employee_id !== requestingEmployeeId) {
      return res.status(403).json({ error: 'Forbidden: You can only access your own payroll' });
    }
    
    res.json(payroll);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// CREATE payroll
app.post('/api/payrolls', async (req, res) => {
  try {
    const { 
      employee_id, 
      pay_period_start, 
      pay_period_end, 
      basic_salary,
      gross_salary, 
      net_salary, 
      payment_date, 
      status,
      
      // Tunjangan dari Data Salary
      position_allowance,
      management_allowance,
      phone_allowance,
      incentive_allowance,
      overtime_allowance,
      total_allowances,
      
      // Komponen Payroll yang Dihitung - Perusahaan (PENDAPATAN TETAP)
      bpjs_health_company,
      jht_company,
      jkk_company,
      jkm_company,
      jp_company,
      subtotal_company,
      
      // Komponen Payroll yang Dihitung - Karyawan (POTONGAN)
      bpjs_health_employee,
      jht_employee,
      jp_employee,
      subtotal_employee,
      
      // Deductions Manual
      kasbon,
      telat,
      angsuran_kredit,
      
      // Total Deductions
      total_deductions,
      
      // Total Pendapatan (Gaji + Tunjangan + BPJS Perusahaan)
      total_pendapatan,
      
      // Additional fields untuk database schema
      bpjs_employee,
      bpjs_company,
      jkk,
      jkm,
      deductions,
      
      // Additional fields
      created_by,
      approved_by,
      approved_at
    } = req.body;
    
    console.log('Received payroll data:', req.body);
    
    // Validate required fields
    if (!employee_id || !pay_period_start || !pay_period_end || !gross_salary || !net_salary) {
      return res.status(400).json({ 
        error: 'Data payroll tidak lengkap',
        required: ['employee_id', 'pay_period_start', 'pay_period_end', 'gross_salary', 'net_salary'],
        received: { employee_id, pay_period_start, pay_period_end, gross_salary, net_salary }
      });
    }

    // Validate employee exists
    const employee = await prisma.employees.findUnique({
      where: { id: employee_id }
    });
    
    if (!employee) {
      return res.status(400).json({ error: 'Karyawan tidak ditemukan' });
    }

		// Guard: larang duplikasi payroll pada bulan yang sama untuk karyawan yang sama (berdasarkan payment_date)
		try {
			const payDate = new Date(payment_date);
			const monthStart = new Date(payDate.getFullYear(), payDate.getMonth(), 1);
			const monthEnd = new Date(payDate.getFullYear(), payDate.getMonth() + 1, 0);

			const existingSameMonth = await prisma.payrolls.findFirst({
				where: {
					employee_id,
					payment_date: {
						gte: monthStart,
						lte: monthEnd
					}
				}
			});

			if (existingSameMonth) {
				return res.status(409).json({
					error: 'Duplikasi payroll pada bulan yang sama tidak diperbolehkan',
					details: {
						employee_id,
						month: payDate.getMonth() + 1,
						year: payDate.getFullYear(),
						existing_payment_date: existingSameMonth.payment_date
					}
				});
			}
		} catch (guardErr) {
			console.error('Error validating monthly uniqueness:', guardErr);
			return res.status(500).json({ error: 'Gagal memvalidasi duplikasi bulanan' });
		}

    // Server-side fallback calculation to ensure critical fields are populated
    const basicSalaryNumber = Number(basic_salary) || 0;

    // Ambil komponen payroll aktif untuk fallback perhitungan
    const activeComponents = await prisma.payroll_components.findMany({ where: { is_active: true } });

    const getComponentAmount = (componentName: string, expectedType: string): number => {
      const comp = activeComponents.find(c => c.name === componentName && c.type === expectedType);
      if (!comp) return 0;
      const percentage = Number(comp.percentage) || 0;
      const amount = Number(comp.amount) || 0;
      if (percentage > 0) return (basicSalaryNumber * percentage) / 100;
      if (amount > 0) return amount;
      return 0;
    };

    // Fallback untuk komponen perusahaan (income)
    const fb_bpjs_health_company = getComponentAmount('BPJS Kesehatan (Perusahaan)', 'income');
    const fb_jht_company = getComponentAmount('BPJS Ketenagakerjaan JHT (Perusahaan)', 'income');
    const fb_jkk_company = getComponentAmount('BPJS Ketenagakerjaan JKK (Perusahaan)', 'income');
    const fb_jkm_company = getComponentAmount('BPJS Ketenagakerjaan JKM (Perusahaan)', 'income');
    const fb_jp_company = getComponentAmount('BPJS Jaminan Pensiun (Perusahaan)', 'income');

    // Fallback untuk komponen karyawan (deduction)
    const fb_bpjs_health_employee = getComponentAmount('BPJS Kesehatan (Karyawan)', 'deduction');
    const fb_jht_employee = getComponentAmount('BPJS Ketenagakerjaan JHT (Karyawan)', 'deduction');
    const fb_jp_employee = getComponentAmount('BPJS Jaminan Pensiun (Karyawan)', 'deduction');

    // Pakai nilai dari body jika ada; jika 0/null, pakai fallback
    const resolved_bpjs_health_company = parseFloat(bpjs_health_company || 0) || fb_bpjs_health_company;
    const resolved_jht_company = parseFloat(jht_company || 0) || fb_jht_company;
    const resolved_jkk_company = parseFloat(jkk_company || 0) || fb_jkk_company;
    const resolved_jkm_company = parseFloat(jkm_company || 0) || fb_jkm_company;
    const resolved_jp_company = parseFloat(jp_company || 0) || fb_jp_company;

    const resolved_bpjs_health_employee = parseFloat(bpjs_health_employee || 0) || fb_bpjs_health_employee;
    const resolved_jht_employee = parseFloat(jht_employee || 0) || fb_jht_employee;
    const resolved_jp_employee = parseFloat(jp_employee || 0) || fb_jp_employee;

    const subtotalCompanyCalc = resolved_bpjs_health_company + resolved_jht_company + resolved_jkk_company + resolved_jkm_company + resolved_jp_company;
    const subtotalEmployeeCalc = resolved_bpjs_health_employee + resolved_jht_employee + resolved_jp_employee;

    const resolved_subtotal_company = parseFloat(subtotal_company || 0) || subtotalCompanyCalc;
    const resolved_subtotal_employee = parseFloat(subtotal_employee || 0) || subtotalEmployeeCalc;

    const resolved_bpjs_company = parseFloat(bpjs_company || 0) || resolved_subtotal_company;
    const resolved_bpjs_employee_total = parseFloat(bpjs_employee || 0) || resolved_subtotal_employee;

    const resolved_total_allowances = parseFloat(total_allowances || 0);
    const resolved_total_pendapatan = parseFloat(total_pendapatan || 0) || (basicSalaryNumber + resolved_total_allowances + resolved_subtotal_company);

    const resolved_total_deductions = parseFloat(total_deductions || 0) || (resolved_subtotal_employee + parseFloat(kasbon || 0) + parseFloat(telat || 0) + parseFloat(angsuran_kredit || 0));
    const resolved_deductions_legacy = parseFloat(deductions || 0) || resolved_total_deductions;

    const data = {
      employee_id,
      pay_period_start: new Date(pay_period_start),
      pay_period_end: new Date(pay_period_end),
      basic_salary: parseFloat(basic_salary || 0),
      gross_salary: parseFloat(gross_salary),
      net_salary: parseFloat(net_salary),
      payment_date: new Date(payment_date),
      status,
      
      // Tunjangan dari Data Salary
      position_allowance: parseFloat(position_allowance || 0),
      management_allowance: parseFloat(management_allowance || 0),
      phone_allowance: parseFloat(phone_allowance || 0),
      incentive_allowance: parseFloat(incentive_allowance || 0),
      overtime_allowance: parseFloat(overtime_allowance || 0),
      total_allowances: resolved_total_allowances,
      
      // Komponen Payroll yang Dihitung - Perusahaan (PENDAPATAN TETAP)
      bpjs_health_company: resolved_bpjs_health_company,
      jht_company: resolved_jht_company,
      jkk_company: resolved_jkk_company,
      jkm_company: resolved_jkm_company,
      jp_company: resolved_jp_company,
      subtotal_company: resolved_subtotal_company,
      
      // Komponen Payroll yang Dihitung - Karyawan (POTONGAN)
      bpjs_health_employee: resolved_bpjs_health_employee,
      jht_employee: resolved_jht_employee,
      jp_employee: resolved_jp_employee,
      subtotal_employee: resolved_subtotal_employee,
      
      // Deductions Manual
      kasbon: parseFloat(kasbon || 0),
      telat: parseFloat(telat || 0),
      angsuran_kredit: parseFloat(angsuran_kredit || 0),
      
      // Total Deductions
      total_deductions: resolved_total_deductions,
      
      // Total Pendapatan (Gaji + Tunjangan + BPJS Perusahaan)
      total_pendapatan: resolved_total_pendapatan,
      
      // Additional fields untuk database schema
      bpjs_employee: resolved_bpjs_employee_total,
      bpjs_company: resolved_bpjs_company,
      jkk: parseFloat(jkk || 0) || resolved_jkk_company,
      jkm: parseFloat(jkm || 0) || resolved_jkm_company,
      deductions: resolved_deductions_legacy,
      
      // Additional fields
      created_by: created_by || null,
      approved_by: approved_by || null,
      approved_at: approved_at ? new Date(approved_at) : null
    };

    console.log('Processed payroll data:', data);

    const payroll = await prisma.payrolls.create({ 
      data,
      include: { 
        employee: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            email: true,
            nik: true
          }
        } 
      }
    });
    
    console.log('Payroll created successfully:', payroll);
    res.status(201).json(payroll);
  } catch (err: any) {
    console.error('Error creating payroll:', err);
    
    // Check for specific Prisma errors
    if (err.code === 'P2002') {
      return res.status(400).json({ error: 'Data payroll dengan periode yang sama sudah ada' });
    }
    
    if (err.code === 'P2003') {
      return res.status(400).json({ error: 'Employee ID tidak valid' });
    }
    
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// UPDATE payroll
app.put('/api/payrolls/:id', async (req, res) => {
  const { id } = req.params;
  const parseResult = payrollSchema.partial().safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Data payroll tidak valid', details: parseResult.error.errors });
  }
  try {
    const payroll = await prisma.payrolls.update({ where: { id }, data: parseResult.data });
    res.json(payroll);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH payroll status (for marking as paid, etc.)
app.patch('/api/payrolls/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    // Validate status
    if (!status || !['PENDING', 'APPROVED', 'PAID', 'REJECTED', 'UNPAID'].includes(status)) {
      return res.status(400).json({ 
        error: 'Status tidak valid. Status yang diizinkan: PENDING, APPROVED, PAID, REJECTED, UNPAID' 
      });
    }
    
    // Check if payroll exists
    const existingPayroll = await prisma.payrolls.findUnique({
      where: { id }
    });
    
    if (!existingPayroll) {
      return res.status(404).json({ error: 'Payroll tidak ditemukan' });
    }
    
    // Update status
    const updatedPayroll = await prisma.payrolls.update({
      where: { id },
      data: { status },
      include: { 
        employee: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            email: true,
            position: true
          }
        } 
      }
    });
    
    res.json(updatedPayroll);
  } catch (err) {
    console.error('Error updating payroll status:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE payroll
app.delete('/api/payrolls/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.payrolls.delete({ where: { id } });
    res.json({ message: 'Payroll deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * CALCULATE payroll components
 * 
 * ALUR PERHITUNGAN:
 * 1. Menerima basic_salary dari frontend (sudah termasuk tunjangan)
 * 2. Mengambil data salary asli dari database untuk perhitungan BPJS
 * 3. Menghitung komponen BPJS berdasarkan basic_salary murni
 * 4. Menghitung breakdown pendapatan:
 *    - pendapatan_tetap = basic_salary (gaji pokok)
 *    - pendapatan_tidak_tetap = total_income (tunjangan)
 *    - total_pendapatan = pendapatan_tetap + pendapatan_tidak_tetap
 * 5. Menghitung deductions:
 *    - total_auto_deduction = BPJS + Pajak (otomatis)
 *    - total_manual_deduction = Kasbon + Telat + Angsuran (manual)
 *    - total_deduction = total_auto_deduction + total_manual_deduction
 * 6. Net Salary = total_pendapatan - total_deduction
 * 7. Mengirimkan breakdown lengkap ke frontend
 */
app.post('/api/payrolls/calculate', async (req, res) => {
  try {
    const { employee_id, basic_salary, manual_deductions } = req.body;
    
    // Validate required fields
    if (!employee_id || !basic_salary) {
      return res.status(400).json({ error: 'Data tidak lengkap' });
    }

    // Convert basic_salary to number
    const basicSalaryNumber = Number(basic_salary) || 0;

    // Get active payroll components
    const activeComponents = await prisma.payroll_components.findMany({
      where: { is_active: true }
    });

    console.log('Active payroll components found:', activeComponents.length);
    console.log('Components:', activeComponents.map(c => ({ name: c.name, type: c.type, category: c.category, percentage: c.percentage, amount: c.amount })));

    // Get employee data
    const employeeData = await prisma.employees.findUnique({
      where: { id: employee_id }
    });

    if (!employeeData) {
      return res.status(404).json({ error: 'Data karyawan tidak ditemukan' });
    }

    console.log('Employee found:', { id: employeeData.id, name: `${employeeData.first_name} ${employeeData.last_name}` });

    // Get salary data dari tabel salary
    const salaryData = await prisma.salary.findUnique({
      where: { employee_id }
    });

    if (!salaryData) {
      return res.status(404).json({ error: 'Data gaji karyawan tidak ditemukan' });
    }

    console.log('Salary data found:', { 
      basic_salary: salaryData.basic_salary,
      position_allowance: salaryData.position_allowance,
      management_allowance: salaryData.management_allowance,
      phone_allowance: salaryData.phone_allowance,
      incentive_allowance: salaryData.incentive_allowance,
      overtime_allowance: salaryData.overtime_allowance
    });

    // Get pure basic salary dari salary data
    const pureBasicSalary = Number(salaryData.basic_salary) || 0;
    
    // Gunakan basic_salary dari frontend untuk kalkulasi total pendapatan
    // basic_salary dari frontend = basic_salary + total_allowances
    const frontendBasicSalary = Number(basic_salary) || 0;
    
    console.log('Salary calculation parameters:', {
      pureBasicSalary,        // Gaji pokok murni dari database
      frontendBasicSalary,    // Total dari frontend (basic + allowances)
      salaryAllowances: {
        position: Number(salaryData.position_allowance) || 0,
        management: Number(salaryData.management_allowance) || 0,
        phone: Number(salaryData.phone_allowance) || 0,
        incentive: Number(salaryData.incentive_allowance) || 0,
        overtime: Number(salaryData.overtime_allowance) || 0
      }
    });

    // Calculate components
    const calculated: any[] = [];
    let totalIncome = 0;
    let totalAutoDeduction = 0;

    activeComponents.forEach((component: any) => {
      let amount = 0;
      let isPercentage = false;

      // Convert Decimal to number for calculations
      const percentage = Number(component.percentage) || 0;
      const componentAmount = Number(component.amount) || 0;

      if (percentage > 0) {
        // Use pure basic salary for percentage calculations
        amount = (pureBasicSalary * percentage) / 100;
        isPercentage = true;
      } else if (componentAmount > 0) {
        amount = componentAmount;
        isPercentage = false;
      }

      // Use component type from database configuration
      let effectiveType = component.type;
      
      calculated.push({
        name: component.name,
        type: effectiveType,
        amount: amount,
        percentage: percentage,
        is_percentage: isPercentage,
        category: component.category,
        pureBasicSalary
      });

      // Calculate totals
      if (effectiveType === 'income') {
        totalIncome += amount;
      } else if (effectiveType === 'deduction') {
        totalAutoDeduction += amount;
      }
    });

    // Calculate manual deductions (harus mengurangi, bukan menambah)
    const manualDeductions = manual_deductions || { kasbon: 0, telat: 0, angsuran_kredit: 0 };
    const totalManualDeduction = manualDeductions.kasbon + manualDeductions.telat + manualDeductions.angsuran_kredit;
    
    // Breakdown pendapatan yang lengkap untuk frontend
    // PENDAPATAN TETAP = Gaji Pokok + Komponen BPJS Company (income)
    // PENDAPATAN TIDAK TETAP = Total Tunjangan (position, management, phone, incentive, overtime)
    
    // Hitung total tunjangan dari data salary
    const totalTunjangan = (
      Number(salaryData.position_allowance || 0) +
      Number(salaryData.management_allowance || 0) +
      Number(salaryData.phone_allowance || 0) +
      Number(salaryData.incentive_allowance || 0) +
      Number(salaryData.overtime_allowance || 0)
    );
    
    // PENDAPATAN TETAP = Gaji Pokok + Komponen BPJS Company (income)
    const pendapatanTetap = pureBasicSalary + totalIncome;
    
    // PENDAPATAN TIDAK TETAP = Total Tunjangan
    const pendapatanTidakTetap = totalTunjangan;
    
    // TOTAL PENDAPATAN = Pendapatan Tetap + Pendapatan Tidak Tetap
    const totalPendapatan = pendapatanTetap + pendapatanTidakTetap;
    
    // Calculate final totals
    const totalDeduction = totalAutoDeduction + totalManualDeduction;  // BPJS + Pajak + Manual
    const netSalary = totalPendapatan - totalDeduction;  // Total Pendapatan - Total Deduction

    console.log('Calculation details:', {
      basicSalaryNumber,
      pureBasicSalary,
      totalIncome,
      totalAutoDeduction,
      totalManualDeduction,
      totalDeduction,
      totalPendapatan,
      netSalary
    });
    
    console.log('Breakdown pendapatan calculation:', {
      pendapatanTetap: pendapatanTetap,
      pendapatanTidakTetap: pendapatanTidakTetap,
      totalPendapatanFinal: totalPendapatan,
      totalTunjangan: totalTunjangan,
      pureBasicSalary: pureBasicSalary,
      totalIncome: totalIncome
    });
    
    const breakdownPendapatan = {
      pendapatan_tetap: pendapatanTetap,           // Gaji Pokok + BPJS Company
      pendapatan_tidak_tetap: pendapatanTidakTetap, // Total Tunjangan
      total_pendapatan: totalPendapatan             // Total yang benar: Pendapatan Tetap + Pendapatan Tidak Tetap
    };

    const response = {
      calculated_components: calculated,
      totals: {
        basic_salary: basicSalaryNumber,
        total_income: totalIncome,
        total_auto_deduction: totalAutoDeduction,
        total_manual_deduction: totalManualDeduction,
        total_deduction: totalDeduction,
        net_salary: netSalary,
        // Breakdown pendapatan yang benar
        pendapatan_tetap: pendapatanTetap,           // Gaji Pokok + BPJS Company
        pendapatan_tidak_tetap: pendapatanTidakTetap, // Total Tunjangan
        total_pendapatan: totalPendapatan             // Total yang benar: Pendapatan Tetap + Pendapatan Tidak Tetap
      },
      pure_basic_salary: pureBasicSalary,
      breakdown_pendapatan: breakdownPendapatan
    };

    console.log('Backend calculation response:', response);
    res.json(response);

  } catch (err) {
    console.error('Error calculating payroll:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/izin-sakit', izinUpload.single('file'), async (req, res) => {
  try {
    let { employee_id, tanggal, jenis, alasan } = req.body;
    console.log('Received izin-sakit request:', { employee_id, tanggal, jenis, alasan, hasFile: !!req.file });
    
    // Ambil employee_id dari session jika tidak dikirim di body
    if (!employee_id) {
      console.log('No employee_id in body, trying to get from session...');
      const sessionId = req.cookies.auth_session;
      if (!sessionId) {
        console.log('No auth_session cookie found');
        return res.status(401).json({ error: 'Unauthorized - No session cookie' });
      }
      const session = await prisma.session.findUnique({ where: { id: sessionId } });
      if (!session) {
        console.log('Session not found:', sessionId);
        return res.status(401).json({ error: 'Unauthorized - Invalid session' });
      }
      const user = await prisma.users.findUnique({ where: { id: session.user_id } });
      if (!user) {
        console.log('User not found for session:', session.user_id);
        return res.status(401).json({ error: 'Unauthorized - User not found' });
      }
      const employee = await prisma.employees.findFirst({ where: { user_id: user.id } });
      if (!employee) {
        console.log('Employee not found for user:', user.id);
        return res.status(400).json({ error: 'Data karyawan tidak ditemukan' });
      }
      employee_id = employee.id;
      console.log('Found employee_id from session:', employee_id);
    }
    
    if (!employee_id || !tanggal || !jenis || !alasan) {
      console.log('Missing required fields:', { employee_id, tanggal, jenis, alasan });
      return res.status(400).json({ error: 'Semua field wajib diisi' });
    }
    // Cek duplikasi izin/sakit pada tanggal yang sama
    const existing = await prisma.izin_sakit.findFirst({
      where: {
        employee_id,
        tanggal: new Date(tanggal)
      }
    });
    if (existing) {
      return res.status(400).json({ error: 'Sudah ada pengajuan izin/sakit pada tanggal yang sama.' });
    }
    // Upload file ke Supabase Storage jika ada req.file
    let filePath = '';
    if (req.file) {
      const fileExt = req.file.originalname.split('.').pop();
      filePath = `izin-sakit/${employee_id}-${Date.now()}.${fileExt}`;
      const { error } = await supabase.storage.from(BUCKET).upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });
      if (error) {
        filePath = `no-file-${Date.now()}`;
      }
    } else {
      filePath = `no-file-${Date.now()}`;
    }
    console.log('Creating izin-sakit record with data:', {
      employee_id,
      tanggal: new Date(tanggal),
      jenis,
      alasan,
      file_path: filePath,
      status: 'PENDING'
    });
    
    const izin = await prisma.izin_sakit.create({
      data: {
        employee_id,
        tanggal: new Date(tanggal),
        jenis,
        alasan,
        file_path: filePath,
        status: 'PENDING'
      }
    });
    
    console.log('Izin-sakit created successfully:', izin.id);
    res.status(201).json(izin);
  } catch (err) {
    console.error('Error creating izin-sakit:', err);
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: `Gagal mengajukan izin/sakit: ${errorMsg}` });
  }
});

app.get('/api/izin-sakit', async (req, res) => {
  try {
    const { employee_id } = req.query;
    if (!employee_id) return res.status(400).json({ error: 'employee_id wajib diisi' });
    const izinList = await prisma.izin_sakit.findMany({
      where: { employee_id: String(employee_id) },
      orderBy: { tanggal: 'desc' }
    });
    res.json(izinList);
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengambil data izin/sakit' });
  }
});

app.get('/api/izin-sakit-all', async (req, res) => {
  try {
    const izinList = await prisma.izin_sakit.findMany({
      include: { 
        employee: {
          include: {
            departemen: true
          }
        }
      },
      orderBy: { tanggal: 'desc' }
    });
    res.json(izinList);
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengambil data izin/sakit' });
  }
});

app.get('/api/izin-sakit-signed-url', async (req, res) => {
  try {
    const { path } = req.query;
    if (!path) return res.status(400).json({ error: 'Path wajib diisi' });
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(String(path), 60 * 60);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ signedUrl: data?.signedUrl });
  } catch (err) {
    res.status(500).json({ error: 'Gagal generate signed URL' });
  }
});

app.put('/api/izin-sakit/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const { keterangan } = req.body;
    
    // Get session from cookie
    const sessionId = req.cookies.auth_session;
    if (!sessionId) return res.status(401).json({ error: 'Unauthorized' });
    
    // Validate session
    const session = await prisma.session.findUnique({
      where: { id: sessionId }
    });
    
    if (!session || session.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const izin = await prisma.izin_sakit.update({
      where: { id },
      data: {
        status: 'APPROVED',
        approved_by: session.user_id,
        approved_at: new Date(),
        keterangan: keterangan || null
      } as any
    });
    res.json(izin);
  } catch (err) {
    res.status(500).json({ error: 'Gagal approve izin/sakit' });
  }
});

app.put('/api/izin-sakit/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const { keterangan } = req.body;
    
    // Get session from cookie
    const sessionId = req.cookies.auth_session;
    if (!sessionId) return res.status(401).json({ error: 'Unauthorized' });
    
    // Validate session
    const session = await prisma.session.findUnique({
      where: { id: sessionId }
    });
    
    if (!session || session.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const izin = await prisma.izin_sakit.update({
      where: { id },
      data: {
        status: 'REJECTED',
        rejected_by: session.user_id,
        rejected_at: new Date(),
        keterangan: keterangan || null
      } as any
    });
    res.json(izin);
  } catch (err) {
    res.status(500).json({ error: 'Gagal reject izin/sakit' });
  }
});

app.get('/api/departemen', async (req, res) => {
  try {
    const list = await prisma.departemen.findMany({ orderBy: { nama: 'asc' } });
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengambil data departemen' });
  }
});

app.post('/api/departemen', async (req, res) => {
  try {
    const { nama } = req.body;
    if (!nama) return res.status(400).json({ error: 'Nama departemen wajib diisi' });
    const exist = await prisma.departemen.findUnique({ where: { nama } });
    if (exist) return res.status(400).json({ error: 'Nama departemen sudah ada' });
    const dep = await prisma.departemen.create({ data: { nama } });
    res.status(201).json(dep);
  } catch (err) {
    res.status(500).json({ error: 'Gagal menambah departemen' });
  }
});

app.put('/api/departemen/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nama } = req.body;
    if (!nama) return res.status(400).json({ error: 'Nama departemen wajib diisi' });
    const exist = await prisma.departemen.findFirst({ where: { nama, NOT: { id } } });
    if (exist) return res.status(400).json({ error: 'Nama departemen sudah ada' });
    const dep = await prisma.departemen.update({ where: { id }, data: { nama } });
    res.json(dep);
  } catch (err) {
    res.status(500).json({ error: 'Gagal update departemen' });
  }
});

app.delete('/api/departemen/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const empCount = await prisma.employees.count({ where: { departemen_id: id } });
    if (empCount > 0) return res.status(400).json({ error: 'Tidak bisa hapus departemen yang masih dipakai karyawan' });
    await prisma.departemen.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Gagal hapus departemen' });
  }
});

// Bulk upload employees endpoint
app.post('/api/employees/bulk', async (req, res) => {
  try {
    console.log('Bulk upload request received');
    console.log('Request headers:', req.headers);
    console.log('Request body type:', typeof req.body);
    
    const employees = req.body;
    console.log('Employees count:', employees?.length || 0);
    
    if (!Array.isArray(employees)) {
      console.log('Invalid data format - not an array');
      return res.status(400).json({ error: 'Data harus berupa array' });
    }

    // Test database connection first
    try {
      await prisma.$queryRaw`SELECT 1`;
      console.log('Database connection OK');
    } catch (dbError) {
      console.error('Database connection failed:', dbError);
      return res.status(500).json({ 
        error: 'Database connection failed',
        details: dbError instanceof Error ? dbError.message : 'Unknown database error'
      });
    }
    
    // Check NIK configurations
    try {
      const nikConfigs = await prisma.department_nik_config.findMany();
      console.log('Available NIK configs:', nikConfigs.map(c => ({
        id: c.id,
        department_id: c.department_id,
        prefix: c.prefix,
        current_sequence: c.current_sequence,
        is_active: c.is_active
      })));
    } catch (configError) {
      console.error('Error checking NIK configs:', configError);
    }

    const results = [];
    const departemenList = await prisma.departemen.findMany();
    console.log('Available departments:', departemenList.length);
    console.log('Department names:', departemenList.map(d => d.nama));
    
    for (const emp of employees) {
      try {
        console.log('Processing employee:', emp.first_name, emp.last_name);
        
        // Validasi data wajib
        if (!emp.first_name || !emp.last_name || !emp.email || !emp.position) {
          console.log('Missing required fields for:', emp.first_name);
          results.push({
            emp,
            error: 'Data wajib tidak lengkap (first_name, last_name, email, position)'
          });
          continue;
        }

        // Cari departemen berdasarkan nama (jika ada) atau gunakan default
        console.log('Looking for department:', emp.department || 'N/A');
        console.log('Available departments:', departemenList.map(d => d.nama));
        
        let departemen;
        
        if (emp.department) {
          // Jika ada department di CSV, cari yang cocok
          departemen = departemenList.find(d => {
            const dbName = d.nama.toLowerCase();
            const csvName = emp.department.toLowerCase();
            
            console.log('Comparing:', dbName, 'vs', csvName);
            
            // Exact match
            if (dbName === csvName) {
              console.log('Exact match found:', d.nama);
              return true;
            }
            
            // Additional matching for "Operational"
            if (dbName === 'operational' && csvName === 'operational') {
              console.log('Direct match found (Operational):', d.nama);
              return true;
            }
            
            // Additional matching for "Operasional" (Indonesian)
            if (dbName === 'operational' && csvName === 'operasional') {
              console.log('Direct match found (Operasional):', d.nama);
              return true;
            }
            
            return false;
          });
        }
        
        // Jika tidak ada department di CSV atau tidak ditemukan, gunakan default
        if (!departemen) {
          console.log('No department specified or not found, using default department');
          
          // Cari departemen "Operational" sebagai default
          departemen = departemenList.find(d => d.nama.toLowerCase() === 'operational');
          
          // Jika tidak ada "Operational", gunakan departemen pertama
          if (!departemen && departemenList.length > 0) {
            departemen = departemenList[0];
            console.log('Using first available department:', departemen.nama);
          }
        }
        
        if (!departemen) {
          console.log('No department available in database');
          results.push({
            emp,
            error: 'Tidak ada departemen yang tersedia di database'
          });
          continue;
        }

        // Cek email sudah ada atau belum
        const existingEmployee = await prisma.employees.findUnique({
          where: { email: emp.email }
        });

        if (existingEmployee) {
          console.log('Email already exists:', emp.email);
          results.push({
            emp,
            error: `Email ${emp.email} sudah terdaftar`
          });
          continue;
        }

        // Generate NIK jika tidak disediakan
        let nik = emp.nik;
        console.log('Original NIK from payload:', nik);
        
        if (!nik || nik.trim() === '') {
          console.log('Generating NIK for:', emp.first_name);
          console.log('Department ID:', departemen.id);
          console.log('Department name:', departemen.nama);
          
          // Get NIK configuration for this department
          const nikConfig = await prisma.department_nik_config.findFirst({
            where: {
              department_id: departemen.id,
              is_active: true
            }
          });
          
          console.log('NIK Config found:', nikConfig);
          
          if (nikConfig) {
            // Generate NIK sesuai format dari database
            const sequence = nikConfig.current_sequence.toString().padStart(nikConfig.sequence_length, '0');
            
            // Cek apakah format_pattern mengandung placeholder
            if (nikConfig.format_pattern) {
              if (nikConfig.format_pattern.includes('{prefix}') && nikConfig.format_pattern.includes('{sequence}')) {
                // Gunakan format_pattern dengan placeholder
                nik = nikConfig.format_pattern
                  .replace('{prefix}', nikConfig.prefix)
                  .replace('{sequence}', sequence);
              } else if (nikConfig.format_pattern === 'PREFIX + SEQUENCE') {
                // Format khusus untuk "PREFIX + SEQUENCE"
                nik = nikConfig.prefix + sequence;
              } else {
                // Format default: prefix + sequence
                nik = nikConfig.prefix + sequence;
              }
            } else {
              // Format default: prefix + sequence
              nik = nikConfig.prefix + sequence;
            }
            
            console.log('Generated NIK from config:', nik);
            console.log('Format pattern used:', nikConfig.format_pattern);
            
            // Update sequence
            await prisma.department_nik_config.update({
              where: { id: nikConfig.id },
              data: { current_sequence: nikConfig.current_sequence + 1 }
            });
          } else {
            console.log('No NIK config found for department:', departemen.nama);
            // Fallback: generate simple NIK
            const timestamp = Date.now().toString().slice(-6);
            nik = `EMP${timestamp}`;
            console.log('Using fallback NIK:', nik);
          }
        } else {
          console.log('NIK already provided:', nik);
        }
        
        console.log('Final NIK to be saved:', nik);
        
        // Validasi NIK tidak boleh kosong
        if (!nik || nik.trim() === '') {
          console.log('NIK is empty, using fallback');
          const timestamp = Date.now().toString().slice(-6);
          nik = `EMP${timestamp}`;
          console.log('Using fallback NIK:', nik);
        }

        // Buat employee baru
        console.log('About to create employee with NIK:', nik);
        console.log('Employee data:', {
            first_name: emp.first_name,
            last_name: emp.last_name,
            email: emp.email,
          nik: nik,
          departemen_id: departemen.id
        });
        
        // Coba simpan dengan raw query untuk debug
        let newEmployee;
        try {
          console.log('=== CREATING EMPLOYEE ===');
          console.log('NIK value before create:', nik);
          console.log('NIK type:', typeof nik);
          console.log('NIK length:', nik ? nik.length : 0);
          
          const employeeData = {
            first_name: emp.first_name,
            last_name: emp.last_name,
            email: emp.email,
            phone_number: emp.phone_number ? emp.phone_number.toString().replace(/[^\d]/g, '') : null,
            position: emp.position,
            departemen_id: departemen.id,
            hire_date: emp.hire_date ? new Date(emp.hire_date) : new Date(),
            bank_account_number: emp.bank_account_number || null,
            address: emp.address || null,
            date_of_birth: emp.date_of_birth ? new Date(emp.date_of_birth) : null,
            bank_name: emp.bank_name || null,
            nik: nik,
          };
          
          console.log('Employee data to create:', employeeData);
          
          newEmployee = await prisma.employees.create({
            data: employeeData
          });
          
          console.log('Employee created successfully. ID:', newEmployee.id);
          console.log('Created employee NIK:', newEmployee.nik);
          
          // Verifikasi NIK tersimpan
          const verifyEmployee = await prisma.employees.findUnique({
            where: { id: newEmployee.id }
          });
          console.log('Verified NIK in DB:', verifyEmployee?.nik);
          
        } catch (createError) {
          console.error('Error creating employee:', createError);
          throw createError;
        }

        console.log('Employee created successfully:', newEmployee.id);
        results.push({
          emp,
          success: true,
          employee: newEmployee
        });

      } catch (err) {
        console.error('Error processing employee:', emp.first_name, err);
        results.push({
          emp,
          error: err instanceof Error ? err.message : 'Error tidak diketahui'
        });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const errorCount = results.filter(r => r.error).length;

    console.log('Bulk upload completed. Success:', successCount, 'Errors:', errorCount);

    res.json({
      success: successCount,
      errorCount: errorCount,
      results
    });

  } catch (err) {
    console.error('Bulk upload error:', err);
    res.status(500).json({ 
      error: 'Gagal upload data karyawan',
      details: err instanceof Error ? err.message : 'Error tidak diketahui'
    });
  }
});

// === Departments Endpoints ===

// Get all departments
app.get('/api/departemen', async (req, res) => {
  try {
    const departments = await prisma.departemen.findMany({
      orderBy: { nama: 'asc' }
    });
    res.json(departments);
  } catch (err) {
    console.error('Error fetching departments:', err);
    res.status(500).json({ error: 'Gagal mengambil data departemen' });
  }
});

// === NIK Configuration Endpoints ===

// Get all department NIK configurations
app.get('/api/department-nik-configs', async (req, res) => {
  try {
    // Cek apakah tabel department_nik_config ada
    try {
      const configs = await prisma.department_nik_config.findMany({
        include: {
          departemen: true
        },
        orderBy: { created_at: 'desc' }
      });
      res.json(configs);
    } catch (prismaError) {
      console.error('Prisma error:', prismaError);
      // Jika tabel belum ada atau belum di-generate, kembalikan array kosong
      res.json([]);
    }
  } catch (err) {
    console.error('Error fetching NIK configs:', err);
    // Jangan error 500, kembalikan array kosong
    res.json([]);
  }
});

// Get active configuration for specific department
app.get('/api/department-nik-configs/:departmentName/active', async (req, res) => {
  try {
    const { departmentName } = req.params;
    
    // First try to find config for specific department
    let config = await prisma.department_nik_config.findFirst({
      where: {
        department_name: departmentName,
        is_active: true
      }
    });

    // If not found, fallback to General department
    if (!config) {
      config = await prisma.department_nik_config.findFirst({
        where: {
          department_name: 'General',
          is_active: true
        }
      });
    }

    if (!config) {
      return res.status(404).json({ error: 'Konfigurasi NIK tidak ditemukan' });
    }

    res.json(config);
  } catch (err) {
    console.error('Error fetching active NIK config:', err);
    res.status(500).json({ error: 'Gagal mengambil konfigurasi NIK aktif' });
  }
});

// Create new department NIK configuration
app.post('/api/department-nik-configs', async (req, res) => {
  try {
    const {
      department_id,
      department_name,
      prefix,
      current_sequence,
      sequence_length,
      format_pattern,
      is_active
    } = req.body;

    // Validate required fields
    if (!department_id || !department_name || !prefix) {
      return res.status(400).json({ error: 'department_id, department_name, dan prefix wajib diisi' });
    }

    // Check if department exists
    const department = await prisma.departemen.findUnique({
      where: { id: department_id }
    });

    if (!department) {
      return res.status(404).json({ error: 'Departemen tidak ditemukan' });
    }

    // Check if config already exists for this department
    const existingConfig = await prisma.department_nik_config.findUnique({
      where: { department_id }
    });

    if (existingConfig) {
      return res.status(400).json({ error: 'Konfigurasi NIK untuk departemen ini sudah ada' });
    }

    const config = await prisma.department_nik_config.create({
      data: {
        department_id,
        department_name,
        prefix,
        current_sequence: current_sequence || 1,
        sequence_length: sequence_length || 3,
        format_pattern: format_pattern || 'PREFIX + SEQUENCE',
        is_active: is_active !== undefined ? is_active : true
      }
    });

    res.status(201).json(config);
  } catch (err) {
    console.error('Error creating NIK config:', err);
    res.status(500).json({ error: 'Gagal membuat konfigurasi NIK' });
  }
});

// Update department NIK configuration
app.put('/api/department-nik-configs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      department_id,
      department_name,
      prefix,
      current_sequence,
      sequence_length,
      format_pattern,
      is_active
    } = req.body;

    const config = await prisma.department_nik_config.update({
      where: { id },
      data: {
        department_id,
        department_name,
        prefix,
        current_sequence,
        sequence_length,
        format_pattern,
        is_active
      }
    });

    res.json(config);
  } catch (err) {
    console.error('Error updating NIK config:', err);
    res.status(500).json({ error: 'Gagal mengupdate konfigurasi NIK' });
  }
});

// Delete department NIK configuration
app.delete('/api/department-nik-configs/:id', async (req, res) => {
  try {
    const { id } = req.params;

    await prisma.department_nik_config.delete({
      where: { id }
    });

    res.json({ message: 'Konfigurasi NIK berhasil dihapus' });
  } catch (err) {
    console.error('Error deleting NIK config:', err);
    res.status(500).json({ error: 'Gagal menghapus konfigurasi NIK' });
  }
});

// Generate next NIK for department
app.post('/api/department-nik-configs/:departmentName/generate-next', async (req, res) => {
  try {
    const { departmentName } = req.params;

    // Get active configuration for department
    let config = await prisma.department_nik_config.findFirst({
      where: {
        department_name: departmentName,
        is_active: true
      }
    });

    // If not found, fallback to General department
    if (!config) {
      config = await prisma.department_nik_config.findFirst({
        where: {
          department_name: 'General',
          is_active: true
        }
      });
    }

    if (!config) {
      return res.status(404).json({ error: 'Konfigurasi NIK tidak ditemukan' });
    }

    // Generate next NIK sesuai format dari database
    const sequence = config.current_sequence.toString().padStart(config.sequence_length, '0');
    
    let nextNIK;
    if (config.format_pattern) {
      // Cek apakah format_pattern mengandung placeholder
      if (config.format_pattern.includes('{prefix}') && config.format_pattern.includes('{sequence}')) {
        // Gunakan format_pattern dengan placeholder
        nextNIK = config.format_pattern
          .replace('{prefix}', config.prefix)
          .replace('{sequence}', sequence);
      } else if (config.format_pattern === 'PREFIX + SEQUENCE') {
        // Format khusus untuk "PREFIX + SEQUENCE"
        nextNIK = config.prefix + sequence;
      } else {
        // Format default: prefix + sequence
        nextNIK = config.prefix + sequence;
      }
    } else {
      // Format default: prefix + sequence
      nextNIK = config.prefix + sequence;
    }

    // Update sequence
    await prisma.department_nik_config.update({
      where: { id: config.id },
      data: { current_sequence: config.current_sequence + 1 }
    });

    console.log('Generated NIK:', nextNIK);
    console.log('Config used:', config);
    
    res.json({ 
      next_nik: nextNIK,
      config: config
    });
  } catch (err) {
    console.error('Error generating next NIK:', err);
    res.status(500).json({ error: 'Gagal generate NIK berikutnya' });
  }
});

// Check NIK configuration for specific department
app.get('/api/department-nik-configs/check/:departmentName', async (req, res) => {
  try {
    const { departmentName } = req.params;
    
    console.log('Checking NIK config for department:', departmentName);
    
    // Get department first
    const department = await prisma.departemen.findFirst({
      where: { nama: departmentName }
    });
    
    if (!department) {
      console.log(`Department '${departmentName}' tidak ditemukan`);
      // Return empty config instead of 404
      return res.json({
        department: null,
        nik_config: null,
        has_config: false
      });
    }
    
    console.log('Department found:', department);
    
    // Get NIK configuration for this department
    const config = await prisma.department_nik_config.findFirst({
      where: {
        department_id: department.id,
        is_active: true
      }
    });
    
    console.log('NIK config found:', config);
    
    res.json({
      department: department,
      nik_config: config,
      has_config: !!config
    });
  } catch (err) {
    console.error('Error checking NIK config:', err);
    res.status(500).json({ error: 'Gagal cek konfigurasi NIK' });
  }
});

// Validate NIK format for department
app.post('/api/department-nik-configs/validate-format', async (req, res) => {
  try {
    const { nik_input, department_name } = req.body;

    if (!nik_input || !department_name) {
      return res.status(400).json({ error: 'nik_input dan department_name wajib diisi' });
    }

    // Get department first
    const department = await prisma.departemen.findFirst({
      where: { nama: department_name }
    });

    if (!department) {
      return res.status(404).json({ error: 'Department tidak ditemukan' });
    }

    // Get active configuration for department
    let config = await prisma.department_nik_config.findFirst({
      where: {
        department_id: department.id,
        is_active: true
      }
    });

    if (!config) {
      return res.status(404).json({ error: 'Konfigurasi NIK tidak ditemukan' });
    }

    // Validate format sesuai format_pattern atau format default
    let expectedRegex;
    let expectedFormat;
    let isValid = false;
    
    if (config.format_pattern) {
      if (config.format_pattern === 'PREFIX + SEQUENCE') {
        // Format khusus untuk "PREFIX + SEQUENCE"
        expectedFormat = config.prefix + '[0-9]{' + config.sequence_length + '}';
        expectedRegex = new RegExp('^' + expectedFormat + '$');
        
        // Untuk Operational, support multiple formats
        if (department_name === 'Operational') {
          isValid = /^OPS[0-9]{3}$/.test(nik_input) || /^OPS19[0-9]{3}$/.test(nik_input);
        } else {
          isValid = expectedRegex.test(nik_input);
        }
      } else if (config.format_pattern.includes('{prefix}') && config.format_pattern.includes('{sequence}')) {
        // Format dengan placeholder
        expectedFormat = config.format_pattern
          .replace('{prefix}', config.prefix)
          .replace('{sequence}', '[0-9]{' + config.sequence_length + '}');
        
        // Escape special characters untuk regex
        expectedRegex = new RegExp('^' + expectedFormat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
        isValid = expectedRegex.test(nik_input);
        
        // Untuk Operational dengan format {prefix}{sequence}, support multiple formats
        if (department_name === 'Operational' && config.prefix === 'OPS19') {
          isValid = /^OPS[0-9]{3}$/.test(nik_input) || /^OPS19[0-9]{3}$/.test(nik_input);
        }
      } else {
        // Format custom
        expectedFormat = config.format_pattern
          .replace('{prefix}', config.prefix)
          .replace('{sequence}', '[0-9]{' + config.sequence_length + '}');
        
        expectedRegex = new RegExp('^' + expectedFormat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
        isValid = expectedRegex.test(nik_input);
      }
    } else {
      // Format default: prefix + sequence
      expectedFormat = config.prefix + '[0-9]{' + config.sequence_length + '}';
      expectedRegex = new RegExp('^' + expectedFormat + '$');
      
      // Untuk Operational, support multiple formats
      if (department_name === 'Operational') {
        isValid = /^OPS[0-9]{3}$/.test(nik_input) || /^OPS19[0-9]{3}$/.test(nik_input);
      } else {
        isValid = expectedRegex.test(nik_input);
      }
    }

    // Generate expected format string
    let expectedFormatString;
    if (department_name === 'Operational') {
      if (config.prefix === 'OPS19') {
        expectedFormatString = 'OPS001 atau OPS19001';
      } else {
        expectedFormatString = 'OPS001';
      }
    } else if (config.format_pattern === 'PREFIX + SEQUENCE') {
      expectedFormatString = config.prefix + '001';
    } else if (config.format_pattern && config.format_pattern.includes('{prefix}') && config.format_pattern.includes('{sequence}')) {
      expectedFormatString = config.format_pattern
        .replace('{prefix}', config.prefix)
        .replace('{sequence}', '001');
    } else {
      expectedFormatString = config.prefix + '001';
    }

    console.log(`Validating NIK: ${nik_input} for department: ${department_name}`);
    console.log(`Config: prefix=${config.prefix}, format_pattern=${config.format_pattern}, sequence_length=${config.sequence_length}`);
    console.log(`Expected regex: ${expectedRegex}`);
    console.log(`Result: isValid=${isValid}, expectedFormat=${expectedFormatString}`);

    res.json({
      is_valid: isValid,
      expected_format: expectedFormatString,
      actual_input: nik_input,
      config: config
    });
  } catch (err) {
    console.error('Error validating NIK format:', err);
    res.status(500).json({ error: 'Gagal validasi format NIK' });
  }
});

// Export endpoints
app.post('/api/export/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const { month, filter } = req.body;
    
    console.log(`Export request: type=${type}, month=${month}, filter=${filter}`);
    
    // Validate type
    if (!['employees', 'leave', 'attendance'].includes(type)) {
      return res.status(400).json({ error: 'Invalid export type' });
    }
    
    // Validate month format (YYYY-MM)
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'Invalid month format. Use YYYY-MM' });
    }
    
    let data: any[] = [];
    let filename = '';
    
    switch (type) {
      case 'employees':
        // Export employee data
        data = await prisma.employees.findMany({
          include: {
            departemen: true,
            user: true
          },
          orderBy: { created_at: 'desc' }
        });
        
        // Transform data for Excel
        const employeeData = data.map(emp => ({
          'NIK': emp.nik || '-',
          'Nama': `${emp.first_name} ${emp.last_name}`,
          'Email': emp.email || '-',
          'Departemen': emp.departemen?.nama || '-',
          'Jabatan': emp.position || '-',
          'Tanggal Bergabung': emp.hire_date ? new Date(emp.hire_date).toLocaleDateString('id-ID') : '-',
          'Status': 'Active', // Default status
          'Tanggal Dibuat': emp.created_at ? new Date(emp.created_at).toLocaleDateString('id-ID') : '-'
        }));
        
        data = employeeData;
        filename = `employees_report_${month}.xlsx`;
        break;
        
      case 'leave':
        // Export leave requests for the specified month
        const startDate = new Date(month + '-01');
        const endDate = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0);
        
        const leaveData = await prisma.leave_requests.findMany({
          where: {
            created_at: {
              gte: startDate,
              lte: endDate
            }
          },
          include: {
            employee: {
              include: {
                departemen: true
              }
            },
            approvedByUser: true,
            rejectedByUser: true
          },
          orderBy: { created_at: 'desc' }
        });
        
        // Transform data for Excel
        const leaveReportData = leaveData.map(leave => {
          // Calculate duration in days
          let duration = '-';
          if (leave.start_date && leave.end_date) {
            const start = new Date(leave.start_date);
            const end = new Date(leave.end_date);
            const diffTime = Math.abs(end.getTime() - start.getTime());
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1; // +1 to include both start and end date
            duration = diffDays.toString();
          }

          return {
            'NIK': leave.employee?.nik || '-',
            'Nama': leave.employee ? `${leave.employee.first_name} ${leave.employee.last_name}` : '-',
            'Departemen': leave.employee?.departemen?.nama || '-',
            'Jenis Cuti': leave.leave_type || '-',
            'Tanggal Mulai': leave.start_date ? new Date(leave.start_date).toLocaleDateString('id-ID') : '-',
            'Tanggal Selesai': leave.end_date ? new Date(leave.end_date).toLocaleDateString('id-ID') : '-',
            'Durasi (Hari)': duration,
            'Alasan': leave.reason || '-',
            'Status': leave.status || '-',
            'Disetujui Oleh': leave.approvedByUser?.username || '-',
            'Ditolak Oleh': leave.rejectedByUser?.username || '-',
            'Tanggal Pengajuan': leave.created_at ? new Date(leave.created_at).toLocaleDateString('id-ID') : '-'
          };
        });
        
        data = leaveReportData;
        filename = `leave_report_${month}.xlsx`;
        break;
        
      case 'attendance':
        // Export attendance data for the specified month
        const attendanceStartDate = new Date(month + '-01');
        const attendanceEndDate = new Date(attendanceStartDate.getFullYear(), attendanceStartDate.getMonth() + 1, 0);
        
        const attendanceData = await prisma.attendance_records.findMany({
          where: {
            date: {
              gte: attendanceStartDate,
              lte: attendanceEndDate
            }
          },
          include: {
            employee: {
              include: {
                departemen: true
              }
            }
          },
          orderBy: { date: 'desc' }
        });
        
        // Transform data for Excel
        const attendanceReportData = attendanceData.map(att => ({
          'NIK': att.employee?.nik || '-',
          'Nama': att.employee ? `${att.employee.first_name} ${att.employee.last_name}` : '-',
          'Departemen': att.employee?.departemen?.nama || '-',
          'Tanggal': att.date ? new Date(att.date).toLocaleDateString('id-ID') : '-',
          'Check In': att.check_in_time ? new Date(att.check_in_time).toLocaleTimeString('id-ID') : '-',
          'Check Out': att.check_out_time ? new Date(att.check_out_time).toLocaleTimeString('id-ID') : '-',
          'Status': att.status || '-',
          'Notes': att.notes || '-'
        }));
        
        data = attendanceReportData;
        filename = `attendance_report_${month}.xlsx`;
        break;
    }
    
    // Create Excel file using XLSX library
    if (data.length > 0) {
      // Create workbook and worksheet
      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.json_to_sheet(data);
      
      // Add worksheet to workbook
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Report');
      
      // Generate Excel buffer
      const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
      
      // Set response headers for Excel file download
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', excelBuffer.length);
      
      res.send(excelBuffer);
    } else {
      // If no data, create empty Excel file
      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.json_to_sheet([{ 'No Data': 'Tidak ada data untuk periode ini' }]);
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Report');
      
      const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
      
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', excelBuffer.length);
      
      res.send(excelBuffer);
    }
    
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Gagal export laporan' });
  }
});

// Payroll Components routes
app.use(payrollComponentsRouter);

// Salary Management routes
app.get('/api/salary', async (req, res) => {
  try {
    const salaryData = await prisma.salary.findMany({
      include: {
        employee: {
          include: {
            departemen: true
          }
        }
      },
      orderBy: { created_at: 'desc' }
    });
    res.json(salaryData);
  } catch (error) {
    console.error('Error fetching salary data:', error);
    res.status(500).json({ error: 'Gagal mengambil data gaji' });
  }
});

// Get salary by employee_id
app.get('/api/salary/employee/:employee_id', async (req, res) => {
  try {
    const { employee_id } = req.params;
    
    const salaryData = await prisma.salary.findUnique({
      where: { employee_id },
      include: {
        employee: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            position: true,
            departemen: true
          }
        }
      }
    });
    
    if (!salaryData) {
      return res.status(404).json({ error: 'Data gaji karyawan tidak ditemukan' });
    }
    
    res.json(salaryData);
  } catch (error) {
    console.error('Error fetching salary data by employee_id:', error);
    res.status(500).json({ error: 'Gagal mengambil data gaji karyawan' });
  }
});

app.post('/api/salary', async (req, res) => {
  try {
    // Debug: Log the entire request body
    console.log('Salary POST request body:', JSON.stringify(req.body, null, 2));
    
    const { 
      employee_id, 
      nik, 
      basic_salary, 
      position_allowance, 
      management_allowance, 
      phone_allowance, 
      incentive_allowance, 
      overtime_allowance 
    } = req.body;

    // Validate required fields
    if (!employee_id || !nik || !basic_salary) {
      return res.status(400).json({ error: 'Employee ID, NIK, dan Basic Salary wajib diisi' });
    }

    // Validate basic salary must be positive
    if (parseFloat(basic_salary) <= 0) {
      return res.status(400).json({ error: 'Basic Salary harus lebih dari 0' });
    }

    // Validate allowances - they can be empty/null, but if provided must be positive numbers
    if (position_allowance !== undefined && position_allowance !== null && position_allowance !== '') {
      const posAllowance = parseFloat(position_allowance);
      if (isNaN(posAllowance) || posAllowance < 0) {
        return res.status(400).json({ error: 'Tunjangan Jabatan harus berupa angka positif atau dikosongkan' });
      }
    }

    if (management_allowance !== undefined && management_allowance !== null && management_allowance !== '') {
      const mgmtAllowance = parseFloat(management_allowance);
      if (isNaN(mgmtAllowance) || mgmtAllowance < 0) {
        return res.status(400).json({ error: 'Tunjangan Manajemen harus berupa angka positif atau dikosongkan' });
      }
    }

    if (phone_allowance !== undefined && phone_allowance !== null && phone_allowance !== '') {
      const phoneAllowance = parseFloat(phone_allowance);
      if (isNaN(phoneAllowance) || phoneAllowance < 0) {
        return res.status(400).json({ error: 'Tunjangan Telepon harus berupa angka positif atau dikosongkan' });
      }
    }

    if (incentive_allowance !== undefined && incentive_allowance !== null && incentive_allowance !== '') {
      const incentiveAllowance = parseFloat(incentive_allowance);
      if (isNaN(incentiveAllowance) || incentiveAllowance < 0) {
        return res.status(400).json({ error: 'Tunjangan Insentif harus berupa angka positif atau dikosongkan' });
      }
    }

    if (overtime_allowance !== undefined && overtime_allowance !== null && overtime_allowance !== '') {
      const overtimeAllowance = parseFloat(overtime_allowance);
      if (isNaN(overtimeAllowance) || overtimeAllowance < 0) {
        return res.status(400).json({ error: 'Tunjangan Lembur harus berupa angka positif atau dikosongkan' });
      }
    }

    // Check if salary record already exists for this employee or NIK
    const existingSalaryByEmployee = await prisma.salary.findUnique({
      where: { employee_id }
    });

    if (existingSalaryByEmployee) {
      console.log('Existing salary found for employee:', existingSalaryByEmployee);
      return res.status(400).json({ error: 'Data gaji untuk karyawan ini sudah ada' });
    }

    const existingSalaryByNIK = await prisma.salary.findUnique({
      where: { nik }
    });

    if (existingSalaryByNIK) {
      console.log('Existing salary found for NIK:', existingSalaryByNIK);
      return res.status(400).json({ error: 'NIK ini sudah digunakan untuk data gaji lain' });
    }

    // Debug: Check if employee exists and has correct NIK
    const employee = await prisma.employees.findUnique({
      where: { id: employee_id },
      select: { id: true, nik: true, first_name: true, last_name: true }
    });

    if (!employee) {
      console.log('Employee not found:', employee_id);
      return res.status(404).json({ error: 'Karyawan tidak ditemukan' });
    }

    console.log('Employee found:', employee);
    
    // Check if NIK matches
    if (employee.nik !== nik) {
      console.log('NIK mismatch:', { employeeNIK: employee.nik, providedNIK: nik });
      return res.status(400).json({ error: 'NIK tidak sesuai dengan karyawan yang dipilih' });
    }

    // Debug: Log the data that will be saved
    const salaryData = {
      employee_id,
      nik,
      basic_salary: parseFloat(basic_salary),
      position_allowance: position_allowance && position_allowance !== '' ? parseFloat(position_allowance) : null,
      management_allowance: management_allowance && management_allowance !== '' ? parseFloat(management_allowance) : null,
      phone_allowance: phone_allowance && phone_allowance !== '' ? parseFloat(phone_allowance) : null,
      incentive_allowance: incentive_allowance && incentive_allowance !== '' ? parseFloat(incentive_allowance) : null,
      overtime_allowance: overtime_allowance && overtime_allowance !== '' ? parseFloat(overtime_allowance) : null
    };
    
    // Validate that all numeric values are valid
    if (isNaN(salaryData.basic_salary)) {
      return res.status(400).json({ error: 'Basic Salary harus berupa angka yang valid' });
    }
    
    // Validate allowances are valid numbers if provided
    if (salaryData.position_allowance !== null && isNaN(salaryData.position_allowance)) {
      return res.status(400).json({ error: 'Tunjangan Jabatan harus berupa angka yang valid' });
    }
    if (salaryData.management_allowance !== null && isNaN(salaryData.management_allowance)) {
      return res.status(400).json({ error: 'Tunjangan Manajemen harus berupa angka yang valid' });
    }
    if (salaryData.phone_allowance !== null && isNaN(salaryData.phone_allowance)) {
      return res.status(400).json({ error: 'Tunjangan Telepon harus berupa angka yang valid' });
    }
    if (salaryData.incentive_allowance !== null && isNaN(salaryData.incentive_allowance)) {
      return res.status(400).json({ error: 'Tunjangan Insentif harus berupa angka yang valid' });
    }
    if (salaryData.overtime_allowance !== null && isNaN(salaryData.overtime_allowance)) {
      return res.status(400).json({ error: 'Tunjangan Lembur harus berupa angka yang valid' });
    }
    
    console.log('Salary data to be saved:', JSON.stringify(salaryData, null, 2));
    
    // Create salary record
    const salary = await prisma.salary.create({
      data: salaryData,
      include: {
        employee: {
          include: {
            departemen: true
          }
        }
      }
    });

    res.status(201).json(salary);
  } catch (error) {
    console.error('Error creating salary:', error);
    if (error instanceof Error) {
      console.error('Error details:', {
        message: error.message,
        stack: error.stack
      });
    }
    res.status(500).json({ error: 'Gagal membuat data gaji' });
  }
});

app.put('/api/salary/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      basic_salary, 
      position_allowance, 
      management_allowance, 
      phone_allowance, 
      incentive_allowance, 
      overtime_allowance 
    } = req.body;

    if (!basic_salary) {
      return res.status(400).json({ error: 'Basic Salary wajib diisi' });
    }

    // Validate basic salary must be positive
    if (parseFloat(basic_salary) <= 0) {
      return res.status(400).json({ error: 'Basic Salary harus lebih dari 0' });
    }

    // Validate allowances - they can be empty/null, but if provided must be positive numbers
    if (position_allowance !== undefined && position_allowance !== null && position_allowance !== '') {
      const posAllowance = parseFloat(position_allowance);
      if (isNaN(posAllowance) || posAllowance < 0) {
        return res.status(400).json({ error: 'Tunjangan Jabatan harus berupa angka positif atau dikosongkan' });
      }
    }

    if (management_allowance !== undefined && management_allowance !== null && management_allowance !== '') {
      const mgmtAllowance = parseFloat(management_allowance);
      if (isNaN(mgmtAllowance) || mgmtAllowance < 0) {
        return res.status(400).json({ error: 'Tunjangan Manajemen harus berupa angka positif atau dikosongkan' });
      }
    }

    if (phone_allowance !== undefined && phone_allowance !== null && phone_allowance !== '') {
      const phoneAllowance = parseFloat(phone_allowance);
      if (isNaN(phoneAllowance) || phoneAllowance < 0) {
        return res.status(400).json({ error: 'Tunjangan Telepon harus berupa angka positif atau dikosongkan' });
      }
    }

    if (incentive_allowance !== undefined && incentive_allowance !== null && incentive_allowance !== '') {
      const incentiveAllowance = parseFloat(incentive_allowance);
      if (isNaN(incentiveAllowance) || incentiveAllowance < 0) {
        return res.status(400).json({ error: 'Tunjangan Insentif harus berupa angka positif atau dikosongkan' });
      }
    }

    if (overtime_allowance !== undefined && overtime_allowance !== null && overtime_allowance !== '') {
      const overtimeAllowance = parseFloat(overtime_allowance);
      if (isNaN(overtimeAllowance) || overtimeAllowance < 0) {
        return res.status(400).json({ error: 'Tunjangan Lembur harus berupa angka positif atau dikosongkan' });
      }
    }

    const salary = await prisma.salary.update({
      where: { id },
      data: {
        basic_salary: parseFloat(basic_salary),
        position_allowance: position_allowance && position_allowance !== '' ? parseFloat(position_allowance) : null,
        management_allowance: management_allowance && management_allowance !== '' ? parseFloat(management_allowance) : null,
        phone_allowance: phone_allowance && phone_allowance !== '' ? parseFloat(phone_allowance) : null,
        incentive_allowance: incentive_allowance && incentive_allowance !== '' ? parseFloat(incentive_allowance) : null,
        overtime_allowance: overtime_allowance && overtime_allowance !== '' ? parseFloat(overtime_allowance) : null
      },
      include: {
        employee: {
          include: {
            departemen: true
          }
        }
      }
    });

    res.json(salary);
  } catch (error) {
    console.error('Error updating salary:', error);
    res.status(500).json({ error: 'Gagal mengupdate data gaji' });
  }
});

app.delete('/api/salary/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.salary.delete({
      where: { id }
    });
    res.json({ message: 'Data gaji berhasil dihapus' });
  } catch (error) {
    console.error('Error deleting salary:', error);
    res.status(500).json({ error: 'Gagal menghapus data gaji' });
  }
});

app.post('/api/salary/bulk-upload', async (req, res) => {
  try {
    const { salaryData } = req.body;

    if (!Array.isArray(salaryData) || salaryData.length === 0) {
      return res.status(400).json({ error: 'Data gaji harus berupa array dan tidak boleh kosong' });
    }

    const results = [];
    const errors = [];

    for (const item of salaryData) {
      try {
        const { 
          employee_id, 
          nik, 
          basic_salary, 
          position_allowance, 
          management_allowance, 
          phone_allowance, 
          incentive_allowance, 
          overtime_allowance 
        } = item;

        // Validate required fields
        if (!employee_id || !nik || !basic_salary) {
          errors.push({ row: item, error: 'Employee ID, NIK, dan Basic Salary wajib diisi' });
          continue;
        }

        // Validate basic salary must be positive
        if (parseFloat(basic_salary) <= 0) {
          errors.push({ row: item, error: 'Basic Salary harus lebih dari 0' });
          continue;
        }

        // Validate allowances cannot be negative
        if (position_allowance && parseFloat(position_allowance) < 0) {
          errors.push({ row: item, error: 'Tunjangan Jabatan tidak boleh minus' });
          continue;
        }

        if (management_allowance && parseFloat(management_allowance) < 0) {
          errors.push({ row: item, error: 'Tunjangan Manajemen tidak boleh minus' });
          continue;
        }

        if (phone_allowance && parseFloat(phone_allowance) < 0) {
          errors.push({ row: item, error: 'Tunjangan Telepon tidak boleh minus' });
          continue;
        }

        if (incentive_allowance && parseFloat(incentive_allowance) < 0) {
          errors.push({ row: item, error: 'Tunjangan Insentif tidak boleh minus' });
          continue;
        }

        if (overtime_allowance && parseFloat(overtime_allowance) < 0) {
          errors.push({ row: item, error: 'Tunjangan Lembur tidak boleh minus' });
          continue;
        }

        // Check if employee exists
        const employee = await prisma.employees.findUnique({
          where: { id: employee_id }
        });

        if (!employee) {
          errors.push({ row: item, error: 'Karyawan tidak ditemukan' });
          continue;
        }

        // Check if salary record already exists for this employee
        const existingSalary = await prisma.salary.findUnique({
          where: { employee_id }
        });

        if (existingSalary) {
          errors.push({ row: item, error: 'Data gaji untuk karyawan ini sudah ada' });
          continue;
        }

        // Create salary record
        const salary = await prisma.salary.create({
          data: {
            employee_id,
            nik,
            basic_salary: parseFloat(basic_salary),
            position_allowance: position_allowance ? parseFloat(position_allowance) : null,
            management_allowance: management_allowance ? parseFloat(management_allowance) : null,
            phone_allowance: phone_allowance ? parseFloat(phone_allowance) : null,
            incentive_allowance: incentive_allowance ? parseFloat(incentive_allowance) : null,
            overtime_allowance: overtime_allowance ? parseFloat(overtime_allowance) : null
          }
        });

        results.push(salary);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        errors.push({ row: item, error: errorMessage });
      }
    }

    res.json({
      success: results.length,
      errorCount: errors.length,
      results,
      errors
    });
  } catch (error) {
    console.error('Error bulk uploading salary:', error);
    res.status(500).json({ error: 'Gagal upload data gaji secara massal' });
  }
});

app.listen(port, () => {
  console.log("Server running on port", port);
});

