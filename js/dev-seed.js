// DEV ONLY — loaded when the URL has ?seed (e.g. index.html?seed#dashboard).
// Fills an EMPTY local store with ~15 months of realistic data so views can be
// tested without a sheet. Never runs on a phone that already has entries.

import { listEntries, addEntries, setKV, emitChange } from './store.js';
import { dateToStr, shortId } from './util.js';

export async function seedIfEmpty() {
  if ((await listEntries({ includeDeleted: true })).length) return false;

  let s = 42;                                         // deterministic PRNG
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (a) => a[Math.floor(rnd() * a.length)];

  const today = new Date();
  const start = new Date(today.getFullYear() - 1, today.getMonth() - 2, 1);
  const entries = [];
  const push = (type, d, category, amount, description) => entries.push({
    id: 'seed-' + shortId() + shortId(), type, date: dateToStr(d), category,
    amount: Math.round(amount * 100) / 100, description, serverKnown: true,
  });

  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const dom = d.getDate();
    if (dom === 1) {
      push('Income', d, 'Salary', 85000 + (d.getFullYear() === today.getFullYear() ? 7000 : 0), 'Monthly salary');
      push('Expense', d, 'Rent', 22000, 'House rent');
    }
    if (dom === 5) push('Expense', d, 'Investments', 15000, 'SIP');
    if (dom === 15 && rnd() < 0.4) push('Income', d, 'Others', 2000 + rnd() * 6000, pick(['Freelance', 'Cashback', 'Interest']));
    if (rnd() < 0.85) push('Expense', d, 'Food', 80 + rnd() * 450, pick(['Swiggy', 'Groceries', 'Paradise biryani', 'Chai & snacks', 'Zepto']));
    if (rnd() < 0.35) push('Expense', d, 'Travel', 40 + rnd() * 400, pick(['Auto rickshaw', 'Metro', 'Uber', 'Petrol']));
    if (rnd() < 0.08) push('Expense', d, 'Shopping', 500 + rnd() * 4000, pick(['Amazon', 'Clothes', 'Myntra', 'Electronics']));
    if (rnd() < 0.06) push('Expense', d, 'Entertainment', 200 + rnd() * 1200, pick(['Movie', 'Netflix', 'Concert']));
    if (rnd() < 0.04) push('Expense', d, 'Others', 100 + rnd() * 2000, pick(['Gift', 'Medicine', 'Haircut']));
  }
  // one entry still waiting to sync, one rejected by the sheet
  entries.push({ id: 'seed-pending', type: 'Expense', date: dateToStr(today), category: 'Food', amount: 186, description: 'Paradise biryani', dirty: true });

  await addEntries(entries);
  // addEntries marks everything dirty; seeded history should look synced
  const db = await (await import('./store.js')).rawDB();
  await new Promise((resolve) => {
    const t = db.transaction('entries', 'readwrite');
    const st = t.objectStore('entries');
    st.getAll().onsuccess = (e) => { for (const x of e.target.result) if (x.id !== 'seed-pending') st.put({ ...x, dirty: false }); };
    t.oncomplete = resolve;
  });

  const ym = (offset, day) => dateToStr(new Date(today.getFullYear(), today.getMonth() + offset, day));
  await setKV('setup', {
    expenseCategories: [
      { name: 'Food', group: 'Variable', budget: 8000 },
      { name: 'Travel', group: 'Variable', budget: 3000 },
      { name: 'Rent', group: 'Fixed', budget: 22000 },
      { name: 'Investments', group: 'Savings', budget: 15000 },
      { name: 'Shopping', group: 'Variable', budget: 4000 },
      { name: 'Entertainment', group: 'Variable', budget: 1500 },
      { name: 'Others', group: 'Variable', budget: null },
    ],
    incomeSources: [{ name: 'Salary', target: 92000 }, { name: 'Others', target: 3000 }],
    groups: ['Fixed', 'Variable', 'Savings', 'Debt'],
    rules: [
      { id: 'r1rent00', type: 'Expense', category: 'Rent', amount: 22000, frequency: 'Monthly', day: 1, start: ym(-14, 1), end: '', description: 'House rent', active: true, lastPosted: ym(-1, 1) },
      { id: 'r2sip000', type: 'Expense', category: 'Investments', amount: 15000, frequency: 'Monthly', day: 5, start: ym(-14, 5), end: '', description: 'SIP', active: true, lastPosted: ym(-1, 5) },
      { id: 'r3netflx', type: 'Expense', category: 'Entertainment', amount: 649, frequency: 'Monthly', day: 12, start: ym(-2, 12), end: '', description: 'Netflix', active: true, lastPosted: '' },
      { id: 'r4salary', type: 'Income', category: 'Salary', amount: 92000, frequency: 'Monthly', day: 1, start: ym(-14, 1), end: '', description: 'Monthly salary', active: false, lastPosted: '' },
    ],
  });
  await setKV('setupMeta', { dirty: false, renames: [] });
  emitChange('all');
  return true;
}
