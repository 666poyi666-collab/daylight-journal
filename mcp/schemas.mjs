import { z } from 'zod'

export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
export const text = z.string()
export const requestId = z.string().uuid()
export const expectedRevision = z.number().int().nonnegative()
export const limit = z.number().int().min(1).max(100).default(20)
export const cursor = z.string().optional()
export const contentOffset = z.number().int().nonnegative().max(100_000).default(0)
export const contentLimit = z.number().int().min(1).max(12_000).default(6_000)
export const mood = z.number().int().min(1).max(5).nullable().optional()
export const tags = z.array(text).max(30).optional()
