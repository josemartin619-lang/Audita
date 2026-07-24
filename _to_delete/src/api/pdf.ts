/**
 * Financial-statement PDF export. Renders NIIF-style Balance General, Estado de
 * Resultados and Estado de Flujos de Efectivo, and stamps the ledger's
 * integrity fingerprint on the document — so a statement handed to a bank
 * traces back to the verifiable, tamper-evident ledger it came from.
 */

import PDFDocument from 'pdfkit';
import type { Response } from 'express';
import { JournalEntry } from '../domain/journal.js';
import { formatCOP } from '../domain/money.js';
import {
  balanceSheet, incomeStatement, cashFlowStatement, trialBalance, naturalBalance,
} from '../domain/reports.js';

interface Meta {
  clientName: string;
  ofeNit: string;
  period: string;      // "2026-06"
  lang: 'es' | 'en';
  seal: string | null; // head of the audit hash chain
}

const L = {
  es: {
    title: 'Estados Financieros', prep: 'Preparados bajo NIIF (Colombia)', nit: 'NIT', period: 'Periodo',
    bs: 'Estado de Situación Financiera (Balance General)', is: 'Estado de Resultados', cf: 'Estado de Flujos de Efectivo',
    assets: 'Activos', cashBanks: 'Efectivo y equivalentes', clients: 'Deudores comerciales (clientes)', ivaDesc: 'IVA descontable', anticipo: 'Anticipo de impuestos (retenciones a favor)', inventory: 'Inventarios',
    totalAssets: 'Total activos', liab: 'Pasivos', ivaPay: 'IVA por pagar', rete: 'Retención por pagar', suppliers: 'Proveedores', totalLiab: 'Total pasivos',
    equity: 'Patrimonio', capital: 'Capital social', result: 'Resultado del ejercicio', totalEquity: 'Total patrimonio', totalLE: 'Total pasivo + patrimonio',
    revenue: 'Ingresos de actividades ordinarias', cogs: 'Costo de ventas', expenses: 'Gastos de administración y ventas', profit: 'Resultado del ejercicio',
    op: 'Flujos de operación', inv: 'Flujos de inversión', fin: 'Flujos de financiación', net: 'Variación neta del efectivo', opening: 'Efectivo inicial', closing: 'Efectivo final',
    ties: 'La balanza de comprobación cuadra', yes: 'Sí', no: 'No',
    integrity: 'Generado desde un libro mayor de integridad verificada (cadena de evidencia SHA-256).',
    fingerprint: 'Huella del libro', generated: 'Generado', pageOf: 'Página',
  },
  en: {
    title: 'Financial Statements', prep: 'Prepared under IFRS (Kingdom of Saudi Arabia)', nit: 'VAT No.', period: 'Period',
    bs: 'Statement of Financial Position (Balance Sheet)', is: 'Income Statement', cf: 'Statement of Cash Flows',
    assets: 'Assets', cashBanks: 'Cash & equivalents', clients: 'Trade receivables', ivaDesc: 'Input VAT (recoverable)', anticipo: 'Withholding tax receivable', inventory: 'Inventories',
    totalAssets: 'Total assets', liab: 'Liabilities', ivaPay: 'Output VAT payable', rete: 'Withholding tax payable', suppliers: 'Trade payables', totalLiab: 'Total liabilities',
    equity: 'Equity', capital: 'Share capital', result: 'Profit for the period', totalEquity: 'Total equity', totalLE: 'Total liabilities + equity',
    revenue: 'Revenue', cogs: 'Cost of sales', expenses: 'Administrative & selling expenses', profit: 'Profit for the period',
    op: 'Operating activities', inv: 'Investing activities', fin: 'Financing activities', net: 'Net change in cash', opening: 'Opening cash', closing: 'Closing cash',
    ties: 'Trial balance ties', yes: 'Yes', no: 'No',
    integrity: 'Generated from an integrity-verified ledger (SHA-256 evidence chain).',
    fingerprint: 'Ledger fingerprint', generated: 'Generated', pageOf: 'Page',
  },
};

const INK = '#2a2118', GOLD = '#a9772a', MUTE = '#6a5a44', LINE = '#d8cdb4';

export function streamStatementsPdf(res: Response, entries: readonly JournalEntry[], meta: Meta, nowIso: string): void {
  const t = L[meta.lang];
  const nat = (c: string) => formatCOP(naturalBalance(c, entries));
  const bs = balanceSheet(entries);
  const is = incomeStatement(entries);
  const cf = cashFlowStatement(entries);
  const tb = trialBalance(entries);

  const doc = new PDFDocument({ size: 'A4', margin: 54, info: { Title: `${t.title} — ${meta.clientName}` } });
  res.setHeader('content-type', 'application/pdf');
  res.setHeader('content-disposition', `attachment; filename="financial-statements-${meta.period}.pdf"`);
  doc.pipe(res);

  const M = 54;
  const right = doc.page.width - M;
  const rowW = right - M;

  // ---- Masthead ----
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(22).text('Audit', M, M, { continued: true }).fillColor(GOLD).text('a');
  doc.fillColor(MUTE).font('Helvetica-Oblique').fontSize(9).text(t.prep, M, M + 28);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(15).text(meta.clientName, M, M + 48);
  doc.fillColor(MUTE).font('Helvetica').fontSize(9)
    .text(`${t.nit}: ${meta.ofeNit}    ·    ${t.period}: ${meta.period}`, M, M + 68);
  doc.moveTo(M, M + 88).lineTo(right, M + 88).strokeColor(LINE).lineWidth(1).stroke();
  doc.y = M + 100;

  const section = (title: string) => {
    doc.moveDown(0.8);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text(title);
    doc.moveTo(M, doc.y + 2).lineTo(right, doc.y + 2).strokeColor(LINE).lineWidth(0.7).stroke();
    doc.moveDown(0.4);
  };
  const row = (label: string, amount: string, bold = false) => {
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor(bold ? INK : MUTE);
    doc.text(label, M, y, { width: rowW * 0.7 });
    doc.fillColor(INK).text(amount, M, y, { width: rowW, align: 'right' });
    doc.moveDown(0.35);
  };
  const rule = () => { doc.moveTo(M, doc.y).lineTo(right, doc.y).strokeColor(LINE).lineWidth(0.5).stroke(); doc.moveDown(0.2); };

  // ---- Balance Sheet ----
  section(t.bs);
  doc.fillColor(MUTE).font('Helvetica-Bold').fontSize(9).text(t.assets); doc.moveDown(0.2);
  row(t.cashBanks, formatCOP(naturalBalance('1000', entries) + naturalBalance('1010', entries)));
  row(t.clients, nat('1100'));
  row(t.ivaDesc, nat('1150'));
  row(t.anticipo, nat('1160'));
  row(t.inventory, nat('1200'));
  rule(); row(t.totalAssets, formatCOP(bs.activos), true); doc.moveDown(0.3);
  doc.fillColor(MUTE).font('Helvetica-Bold').fontSize(9).text(t.liab); doc.moveDown(0.2);
  row(t.suppliers, nat('2000'));
  row(t.ivaPay, nat('2100'));
  row(t.rete, nat('2110'));
  rule(); row(t.totalLiab, formatCOP(bs.pasivos), true); doc.moveDown(0.3);
  doc.fillColor(MUTE).font('Helvetica-Bold').fontSize(9).text(t.equity); doc.moveDown(0.2);
  row(t.capital, nat('3000'));
  row(t.result, formatCOP(is.utilidad));
  rule(); row(t.totalEquity, formatCOP(bs.patrimonio), true);
  row(t.totalLE, formatCOP(bs.pasivos + bs.patrimonio), true);

  // ---- Income Statement ----
  section(t.is);
  row(t.revenue, formatCOP(is.ingresos));
  row(t.cogs, formatCOP(-is.costo));
  row(t.expenses, formatCOP(-is.gastos));
  rule(); row(t.profit, formatCOP(is.utilidad), true);

  // ---- Cash Flows ----
  section(t.cf);
  row(t.op, formatCOP(cf.operating));
  row(t.inv, formatCOP(cf.investing));
  row(t.fin, formatCOP(cf.financing));
  rule(); row(t.net, formatCOP(cf.netChange), true);
  row(t.opening, formatCOP(cf.openingCash));
  row(t.closing, formatCOP(cf.closingCash), true);

  // ---- Integrity footer ----
  doc.moveDown(1.2);
  doc.moveTo(M, doc.y).lineTo(right, doc.y).strokeColor(LINE).lineWidth(1).stroke();
  doc.moveDown(0.5);
  doc.fillColor(MUTE).font('Helvetica').fontSize(8);
  doc.text(`${t.ties}: ${tb.balanced ? t.yes : t.no}`, M, doc.y);
  doc.text(t.integrity, M, doc.y + 2);
  if (meta.seal) {
    doc.font('Courier').fontSize(7).fillColor(INK).text(`${t.fingerprint}: ${meta.seal}`, M, doc.y + 2, { width: rowW });
  }
  doc.font('Helvetica').fontSize(8).fillColor(MUTE).text(`${t.generated}: ${nowIso}`, M, doc.y + 2);

  doc.end();
}
