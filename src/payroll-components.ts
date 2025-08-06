import { Router } from 'express';
import { db } from './db.js';

const router = Router();

// Get all payroll components
router.get('/api/payroll-components', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM payroll_components ORDER BY type, category, name'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching payroll components:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get payroll component by ID
router.get('/api/payroll-components/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      'SELECT * FROM payroll_components WHERE id = $1',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Payroll component not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching payroll component:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create new payroll component
router.post('/api/payroll-components', async (req, res) => {
  try {
    const { name, type, category, percentage, amount, description } = req.body;
    
    const result = await db.query(
      `INSERT INTO payroll_components (name, type, category, percentage, amount, description)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, type, category, percentage || 0, amount || 0, description]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating payroll component:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update payroll component
router.put('/api/payroll-components/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, type, category, percentage, amount, description, is_active } = req.body;
    
    const result = await db.query(
      `UPDATE payroll_components 
       SET name = $1, type = $2, category = $3, percentage = $4, amount = $5, 
           description = $6, is_active = $7, updated_at = CURRENT_TIMESTAMP
       WHERE id = $8
       RETURNING *`,
      [name, type, category, percentage || 0, amount || 0, description, is_active, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Payroll component not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating payroll component:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete payroll component
router.delete('/api/payroll-components/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await db.query(
      'DELETE FROM payroll_components WHERE id = $1 RETURNING *',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Payroll component not found' });
    }
    
    res.json({ message: 'Payroll component deleted successfully' });
  } catch (error) {
    console.error('Error deleting payroll component:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Toggle payroll component active status
router.patch('/api/payroll-components/:id/toggle', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await db.query(
      `UPDATE payroll_components 
       SET is_active = NOT is_active, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Payroll component not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error toggling payroll component:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get payroll components statistics
router.get('/api/payroll-components/stats', async (req, res) => {
  try {
    const stats = await db.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN type = 'income' THEN 1 END) as income_count,
        COUNT(CASE WHEN type = 'deduction' THEN 1 END) as deduction_count,
        COUNT(CASE WHEN category = 'bpjs' THEN 1 END) as bpjs_count,
        COUNT(CASE WHEN is_active = true THEN 1 END) as active_count
      FROM payroll_components
    `);
    
    res.json(stats.rows[0]);
  } catch (error) {
    console.error('Error fetching payroll components stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router; 