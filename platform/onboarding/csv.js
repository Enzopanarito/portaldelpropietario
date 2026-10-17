'use strict';

function parseCsv(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      if (field.length !== 0) throw Object.assign(new Error('Unexpected quote in CSV field'), { code: 'CSV_INVALID_QUOTE' });
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (quoted) throw Object.assign(new Error('Unclosed quoted CSV field'), { code: 'CSV_UNCLOSED_QUOTE' });
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }

  const nonEmpty = rows.filter(values => values.some(value => String(value).trim() !== ''));
  if (!nonEmpty.length) return [];
  const headers = nonEmpty[0].map(value => String(value).trim());
  if (headers.some(header => !header)) throw Object.assign(new Error('CSV headers cannot be empty'), { code: 'CSV_HEADER_EMPTY' });
  if (new Set(headers).size !== headers.length) throw Object.assign(new Error('CSV headers must be unique'), { code: 'CSV_HEADER_DUPLICATE' });

  return nonEmpty.slice(1).map((values, rowIndex) => {
    if (values.length > headers.length) {
      throw Object.assign(new Error(`CSV row ${rowIndex + 2} has too many columns`), { code: 'CSV_ROW_TOO_WIDE', row: rowIndex + 2 });
    }
    const record = {};
    headers.forEach((header, index) => { record[header] = String(values[index] ?? '').trim(); });
    return record;
  });
}

function stringifyCsv(headers, rows) {
  const escape = value => {
    const raw = String(value ?? '');
    return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
  };
  return [headers, ...rows.map(row => headers.map(header => row[header] ?? ''))]
    .map(values => values.map(escape).join(','))
    .join('\n') + '\n';
}

module.exports = { parseCsv, stringifyCsv };
