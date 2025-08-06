import { Router } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

// Get all payroll components
router.get('/api/payroll-components', async (req, res) => {
  try {
    const components = await prisma.payroll_components.findMany({
      orderBy: [
        { type: 'asc' },
        { category: 'asc' },
        { name: 'asc' }
      ]
    });
    res.json(components);
  } catch (error) {
    console.error('Error fetching payroll components:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get payroll component by ID
router.get('/api/payroll-components/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const component = await prisma.payroll_components.findUnique({
      where: { id: parseInt(id) }
    });
    
    if (!component) {
      return res.status(404).json({ error: 'Payroll component not found' });
    }
    
    res.json(component);
  } catch (error) {
    console.error('Error fetching payroll component:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create new payroll component
router.post('/api/payroll-components', async (req, res) => {
  try {
    const { name, type, category, percentage, amount, description } = req.body;
    
    const component = await prisma.payroll_components.create({
      data: {
        name,
        type,
        category,
        percentage: percentage || 0,
        amount: amount || 0,
        description
      }
    });
    
    res.status(201).json(component);
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
    
    const component = await prisma.payroll_components.update({
      where: { id: parseInt(id) },
      data: {
        name,
        type,
        category,
        percentage: percentage || 0,
        amount: amount || 0,
        description,
        is_active,
        updated_at: new Date()
      }
    });
    
    res.json(component);
  } catch (error) {
    console.error('Error updating payroll component:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete payroll component
router.delete('/api/payroll-components/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    await prisma.payroll_components.delete({
      where: { id: parseInt(id) }
    });
    
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
    
    const currentComponent = await prisma.payroll_components.findUnique({
      where: { id: parseInt(id) }
    });
    
    if (!currentComponent) {
      return res.status(404).json({ error: 'Payroll component not found' });
    }
    
    const component = await prisma.payroll_components.update({
      where: { id: parseInt(id) },
      data: {
        is_active: !currentComponent.is_active,
        updated_at: new Date()
      }
    });
    
    res.json(component);
  } catch (error) {
    console.error('Error toggling payroll component:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get payroll components statistics
router.get('/api/payroll-components/stats', async (req, res) => {
  try {
    const [
      total,
      incomeCount,
      deductionCount,
      bpjsCount,
      activeCount
    ] = await Promise.all([
      prisma.payroll_components.count(),
      prisma.payroll_components.count({ where: { type: 'income' } }),
      prisma.payroll_components.count({ where: { type: 'deduction' } }),
      prisma.payroll_components.count({ where: { category: 'bpjs' } }),
      prisma.payroll_components.count({ where: { is_active: true } })
    ]);
    
    res.json({
      total,
      income_count: incomeCount,
      deduction_count: deductionCount,
      bpjs_count: bpjsCount,
      active_count: activeCount
    });
  } catch (error) {
    console.error('Error fetching payroll components stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router; 