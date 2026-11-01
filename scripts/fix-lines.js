import fs from 'node:fs';

const file = 'src/execution/execution-engine.ts';
let lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('Margin/Leg:*')) {
    lines[i] = lines[i].replace('`${marginPerLeg} USDT`', '`$${marginPerLeg} USDT`');
    console.log('Fixed line', i + 1, lines[i]);
  }
  if (lines[i].includes('• *Binance:*') && lines[i].includes('@ `')) {
    lines[i] = lines[i].replace('@ `${bPrice}`', '@ `$${bPrice}`');
    console.log('Fixed line', i + 1, lines[i]);
  }
  if (lines[i].includes('• *Bybit:*') && lines[i].includes('@ `')) {
    lines[i] = lines[i].replace('@ `${byPrice}`', '@ `$${byPrice}`');
    console.log('Fixed line', i + 1, lines[i]);
  }
}

fs.writeFileSync(file, lines.join('\r\n'), 'utf8');

