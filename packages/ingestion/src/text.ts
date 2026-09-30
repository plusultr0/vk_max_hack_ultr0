export function normalizeDate(value:string|null):string|null {
  if(!value)return null;
  const trimmed=value.trim();let result:string|null=null;
  const ru=/^(\d{2})[.\/-](\d{2})[.\/-](\d{4})$/.exec(trimmed);
  const iso=/^(\d{4})[.\/-](\d{2})[.\/-](\d{2})(?:[ T].*)?$/.exec(trimmed);
  if(ru)result=`${ru[3]}-${ru[2]}-${ru[1]}`;
  else if(iso)result=`${iso[1]}-${iso[2]}-${iso[3]}`;
  if(!result)return null;
  const date=new Date(result+'T00:00:00Z');
  return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===result?result:null;
}

function safeCodePoint(code:number):string { return Number.isInteger(code)&&code>=0&&code<=0x10ffff&&!(code>=0xd800&&code<=0xdfff)?String.fromCodePoint(code):'\ufffd'; }

export function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_match, code: string) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => safeCodePoint(Number.parseInt(code, 16)));
}

export function htmlToText(html: string): string {
  return decodeHtml(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}


export function parseCsv(text: string): Array<Record<string, string>> {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiters = [',', ';', '\t'] as const;
  const delimiter = delimiters.map((d) => ({ d, n: firstLine.split(d).length })).sort((a, b) => b.n - a.n)[0]?.d ?? ',';
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && char === delimiter) {
      currentRow.push(current);
      current = '';
      continue;
    }
    if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      currentRow.push(current);
      if (currentRow.some((cell) => cell.trim() !== '')) rows.push(currentRow);
      currentRow = [];
      current = '';
      continue;
    }
    current += char;
  }
  if (current.length || currentRow.length) {
    currentRow.push(current);
    if (currentRow.some((cell) => cell.trim() !== '')) rows.push(currentRow);
  }
  if (rows.length < 2) return [];
  const headers = rows[0]!.map((value, index) => value.trim() || `column_${index + 1}`);
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ''])));
}

