import { Fragment } from 'react';

/** Mail text stays plain; only explicit web URLs become safe, separate-page links. */
function linkedText(text: string) {
  return text.split(/(https?:\/\/[^\s<>"']+)/gi).map((part, index) => {
    if (!/^https?:\/\//i.test(part)) return part;
    const address = part.replace(/[.,;:!?]+$/, '');
    try {
      const url = new URL(address);
      if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)) return part;
      return <Fragment key={index}><a href={url.href} target="_blank" rel="noopener noreferrer">{address}</a>{part.slice(address.length)}</Fragment>;
    } catch { return part; }
  });
}

export default function MessageText({ text }: { text: string }) {
  const lines = text.split('\n');
  const quoted = lines.findIndex(line => /^\s*>/.test(line) || /^On .+wrote:\s*$/i.test(line));
  return <div className="mail-message-body">{quoted < 0 ? linkedText(text) : <>{linkedText(lines.slice(0, quoted).join('\n'))}<details className="mail-quoted"><summary>Show quoted conversation</summary>{linkedText(lines.slice(quoted).join('\n'))}</details></>}</div>;
}
