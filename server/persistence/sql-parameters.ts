/** Convert positional SQLite placeholders while preserving SQL literals, identifiers and comments. */
export function postgresParameters(sql: string): string {
  let output = '', parameter = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      output += c;
      let closed = false;
      for (i++; i < sql.length; i++) {
        output += sql[i];
        if (sql[i] === c) {
          if (sql[i + 1] === c) { output += sql[++i]; continue; }
          closed = true; break;
        }
      }
      if (!closed) throw new Error('Invalid SQL literal');
    } else if (c === '-' && sql[i + 1] === '-') {
      for (; i < sql.length && sql[i] !== '\n'; i++) output += sql[i];
      if (i < sql.length) output += '\n';
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Invalid SQL comment');
      output += sql.slice(i, end + 2); i = end + 1;
    } else if (c === '?') output += `$${++parameter}`;
    else output += c;
  }
  return output;
}
