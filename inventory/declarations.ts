import type {Expr, FieldSchema, Scalar} from '../semantic/types.ts';

export const lit = (value: Scalar): Expr => ({op: 'literal', value});
export const input = (name: string): Expr => ({op: 'input', name});
export const field = (binding: string, name: string): Expr => ({op: 'field', binding, field: name});
export const bin = (op: Extract<Expr, {left: Expr}>['op'], left: Expr, right: Expr): Expr => ({op, left, right});
export const integer = (min: number): Extract<FieldSchema, {type: 'integer'}> => ({type: 'integer', min});
