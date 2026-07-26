import { z } from 'zod'

export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
export const text = z.string()
export const requestId = z.string().uuid()
export const expectedRevision = z.number().int().nonnegative()
export const limit = z.number().int().min(1).max(100).default(20)
export const cursor = z.string().optional()
export const mood = z.number().int().min(1).max(5).nullable().optional()
export const tags = z.array(text).max(30).optional()
