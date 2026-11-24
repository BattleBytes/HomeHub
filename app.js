import { api, configured, observeSession, sendCode, verifyCode, signOut, watchChanges } from './backend.js';

const main = document.querySelector('#main');
const nav = document.querySelector('#nav');
const switcher = document.querySelector('#switcher');
const dialog = document.querySelector('#dialog');
const notice = document.querySelector('#notice');
const days = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const statuses = ['Pending','In Progress','Scheduled','Completed'];
const tabs = [
  ['overview','Overview','M3 10 12 3l9 7M5 9v11h14V9M10 20v-6h4v6'],
  ['order','To Order','M4 5h2l2 10h10l2-7H7m2 11h.01m8 0h.01'],
  ['work','Maintenance Work','m14 6 4 4m-8 4-6 6m5-5 5-5c-2-4 1-7 5-7l-2 4 3 2 3-2c0 4-3 7-7 5l-5 5'],
  ['contacts','Contacts','M5 3h14v18H5zM3 7h4M3 12h4M3 17h4m3-1c0-4 6-4 6 0m-1-6a2 2 0 1 0-4 0 2 2 0 0 0 4 0'],
  ['household','Household','M13 19v-2c0-4-10-4-10 0v2m13-5c3 0 5 1 5 3v2M11 8a3 3 0 1 0-6 0 3 3 0 0 0 6 0m4-3a3 3 0 1 1 0 6']
];
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const base = '/api/households';
let account, data, selected, snapshot, flashTimer, invite, sessionUser, emailForCode, signInError, search = '', requestVersion = 0;
const expanded = new Set();
const tab = () => tabs.find(([key]) => location.hash === '#' + key)?.[0] || 'overview';
const path = segment => base + '/' + encodeURIComponent(selected) + (segment ? '/' + segment : '');
const button = (label,action,value='',type='') => `<button type="button" class="${type}" data-action="${action}" data-value="${escape(value)}">${label}</button>`;
const link = (label,target,type='') => `<a class="button ${type}" href="${escape(target)}">${label}</a>`;
const title = (name,sub='') => `<div class="intro"><h1 id="page-title">${escape(name)}</h1>${sub ? `<p class="muted">${escape(sub)}</p>` : ''}</div>`;
const empty = label => `<p class="empty">${label}</p>`;
const head = (label,actions='') => `<div class="section-head"><h2>${label}</h2>${actions ? `<div class="actions">${actions}</div>` : ''}</div>`;
const options = (items,value='') => items.map(([id,name]) => `<option value="${escape(id)}"${id === value ? ' selected' : ''}>${escape(name)}</option>`).join('');
const select = (label,name,items,value) => `<label>${label}<select name="${name}">${options(items,value)}</select></label>`;
const input = (label,name,value='',attributes='') => `<label>${label}<input name="${name}" value="${escape(value)}" ${attributes}></label>`;
const itemNames = () => [...new Set(data.items.map(item => item.item_key))].sort();
const itemFields = (entry={}) => `<div class="item-fields">${input('Item name','name',entry.name,'required maxlength="100" list="homehub-item-names"')}${input('Quantity','quantity',entry.quantity ?? 1,'required type="number" min="1" max="9999"')}</div><datalist id="homehub-item-names">${options(itemNames().map(value => [value,value]))}</datalist>`;
const members = (placeholder) => [['',placeholder],...data.members.map(member => [member.uid,member.name])];
const memberName = id => data.members.find(member => member.uid === id)?.name;
const date = time => new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(time);
const displayItem = name => name.charAt(0).toLocaleUpperCase() + name.slice(1);
const tel = phone => 'tel:' + phone.replace(/[^+\d]/g,'');
const form = (fields,label,attributes='') => `<form class="field-form" ${attributes}>${fields}<div class="actions"><button class="primary" type="submit">${label}</button></div><p class="form-error" role="alert" hidden></p></form>`;

function toast(message) {
  notice.textContent = message;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { notice.textContent = ''; },4500);
}
function showFailure(error) {
  if (error.status === 401 || error.status === 403) {
    account = data = null;
    if (dialog.open) dialog.close();
    signInError = error.message;
    render();
    return;
  }
  if (!data) main.innerHTML = title('HomeHub') + '<p role="alert">' + escape(error.message) + '</p>' + button('Retry','retry');
  else toast(error.message);
}
async function refresh(quiet=false) {
  const version = ++requestVersion;
  try {
    const nextAccount = await api(base);
    if (version !== requestVersion) return;
    const next = nextAccount.households.some(h => h.id === selected) ? selected : nextAccount.households[0]?.id;
    const nextData = next ? await api(base + '/' + encodeURIComponent(next)) : null;
    if (version !== requestVersion) return;
    const signature = JSON.stringify([nextAccount,nextData]);
    if (quiet && (signature === snapshot || (selected === next && (dialog.open || document.activeElement.matches('input,select,textarea'))))) return;
    if (selected !== next && dialog.open) dialog.close();
    if (selected !== next) { invite = null; expanded.clear(); search = ''; }
    snapshot = signature;
    account = nextAccount;
    data = nextData;
    selected = next;
    render();
  } catch (error) {
    if (version !== requestVersion) return;
    if (error.status === 404 && selected) {
      selected = data = invite = null;
      render();
      return refresh();
    }
    if (!quiet || !data || error.status === 401 || error.status === 403) showFailure(error);
  }
}
function groups(items) {
  const grouped = new Map();
  for (const item of items) {
    const entry = grouped.get(item.item_key) || {name:displayItem(item.name),quantity:0,rows:[]};
    entry.quantity += item.quantity;
    entry.rows.push(item);
    grouped.set(item.item_key,entry);
  }
  return [...grouped].sort(([a],[b]) => a.localeCompare(b));
}
const current = () => data.items.filter(item => !item.batch);
function shoppingRow([key,item], detail=false) {
  const line = `<strong>${escape(item.name)}</strong><span class="qty">${item.quantity}</span>`;
  if (!detail) return `<div class="row row-line">${line}</div>`;
  return `<details class="row" data-key="${escape(key)}"${expanded.has(key) ? ' open' : ''}><summary class="row-line">${line}<span class="detail-mark" aria-hidden="true">+</span></summary>${item.rows.map(row => `<div class="subrow row-line"><span>${escape(row.creator)} · ${row.quantity}</span>${row.uid === account.uid ? `<div class="actions">${button('Edit','edit-item',row.id)}${button('Delete','delete-item',row.id,'danger')}</div>` : ''}</div>`).join('')}<div class="actions spaced">${button('Mark ordered','order-group',key)}</div></details>`;
}
function taskRow(task, detail=false) {
  const contact = data.contacts.find(entry => entry.id === task.contact);
  return `<div class="row"><div class="row-line"><strong>${escape(task.description)}</strong><span class="pill">${escape(task.status)}</span></div><p class="muted">${escape(memberName(task.assignee) || 'Unassigned')}${task.due ? ' · Due ' + escape(task.due) : ''}${detail ? ' · Added by ' + escape(task.creator) : ''}</p>${contact || detail ? `<div class="actions spaced">${contact ? link('Call ' + escape(contact.name),tel(contact.phone)) : ''}${detail ? button('Edit','edit-task',task.id) + button('Delete','delete-task',task.id,'danger') : ''}</div>` : ''}</div>`;
}
function overview() {
  const pending = groups(current());
  const tasks = data.tasks.filter(task => task.status !== 'Completed');
  return title(data.household.name,'Household overview') +
    `<div class="metrics"><div class="metric"><strong>${pending.length}</strong><span>Unique items to order</span></div><div class="metric"><strong>${tasks.length}</strong><span>Outstanding maintenance tasks</span></div></div>
    <div class="layout overview-grid"><section class="card">${head('To Order',button('Add Item','add-item','','primary') + link('View All','#order'))}${pending.slice(0,5).map(row => shoppingRow(row)).join('') || empty('The shopping list is empty.')}</section>
    <section class="card">${head('Maintenance Work',button('Add Work','add-task','','primary') + link('View All','#work'))}${tasks.slice(0,4).map(task => taskRow(task)).join('') || empty('No outstanding maintenance work.')}</section></div>`;
}
function ordering() {
  const pending = groups(current());
  const batches = Map.groupBy ? Map.groupBy(data.items.filter(item => item.batch), item => item.batch) : data.items.reduce((map,item) => { if (item.batch) map.set(item.batch,[...(map.get(item.batch)||[]),item]); return map; },new Map());
  const history = [...batches].sort((a,b) => b[1][0].ordered - a[1][0].ordered);
  return title('To Order') + `<div class="layout">
    <section class="card">${head('Add Item')}${form(itemFields(),'Add Item','data-form="item"')}</section>
    <section class="card">${head('Shopping list',pending.length ? button('Copy list','copy-list') + button('WhatsApp','whatsapp') : '')}${pending.map(row => shoppingRow(row,true)).join('') || empty('No items to order.')}
    ${pending.length ? `<div class="actions spaced">${button('Mark all ordered','order-all','','primary')}</div>` : ''}</section>
    <section class="card">${head('Ordered history')}${history.map(([batch,rows]) => `<div class="row"><div class="row-line"><small>${escape(date(rows[0].ordered))}</small>${button('Undo order','undo',batch)}</div>${groups(rows).map(row => shoppingRow(row)).join('')}</div>`).join('') || empty('No orders yet.')}</section></div>`;
}
function work() {
  return title('Maintenance Work') + `<div class="layout"><section class="card">${head('Outstanding',button('Add Work','add-task','','primary'))}${data.tasks.filter(task => task.status !== 'Completed').map(task => taskRow(task,true)).join('') || empty('No outstanding tasks.')}</section>
    <section class="card">${head('Completed')}${data.tasks.filter(task => task.status === 'Completed').map(task => taskRow(task,true)).join('') || empty('No completed tasks.')}</section></div>`;
}
function contactRows() {
  const term = search.trim().toLowerCase();
  return data.contacts.filter(contact => [contact.name,contact.phone,contact.notes].some(value => value.toLowerCase().includes(term))).map(contact => `<div class="row"><strong>${escape(contact.name)}</strong><p><a href="${tel(contact.phone)}">${escape(contact.phone)}</a></p>${contact.notes ? `<p class="muted">${escape(contact.notes)}</p>` : ''}
    <div class="actions spaced">${link('Call',tel(contact.phone))}${button('Copy number','copy-phone',contact.id)}${button('Edit','edit-contact',contact.id)}${button('Delete','delete-contact',contact.id,'danger')}</div></div>`).join('') || empty(term ? 'No matching contacts.' : 'No contacts added yet.');
}
function contacts() {
  return title('Contacts') + `<section class="card">${head('Phonebook',button('Add Contact','add-contact','','primary'))}<div class="search">${input('Search','search',search,'type="search" placeholder="Name, number or notes"')}</div><div id="contact-rows">${contactRows()}</div></section>`;
}
function household() {
  const h = data.household;
  const admin = data.members.some(member => member.uid === account.uid && member.role === 'admin');
  const code = data.inviteExpiry && invite?.expires === data.inviteExpiry ? invite.code : '';
  return title('Household',h.name) + `<div class="layout household-grid">
    <section class="card">${head('Members')}${data.members.map(member => `<div class="row"><div class="row-line"><strong>${escape(member.name)}${member.uid === account.uid ? ' (you)' : ''}</strong><span class="pill">${member.role === 'admin' ? 'Admin' : 'Member'}</span></div>
      ${admin && member.uid !== account.uid ? `<div class="actions spaced">${button(member.role === 'admin' ? 'Make member' : 'Make admin','role',member.uid)}${button('Remove','remove-member',member.uid,'danger')}</div>` : ''}</div>`).join('')}</section>
    <section class="card">${head('Weekly ordering')}${admin ? form(input('Household name','name',h.name,'required maxlength="80"') + select('Ordering day','day',days.map(day => [day,day]),h.day) + select('Responsible member','buyer',members('Unassigned'),h.buyer || ''),'Save settings','data-form="settings"') + `<div class="actions spaced">${button('Rotate responsibility','rotate')}</div>` : `<p>${escape(h.day)} · ${escape(memberName(h.buyer) || 'Unassigned')}</p>`}</section>
    ${admin ? `<section class="card stack">${head('Invitation code')}${data.inviteExpiry ? `<p class="muted">Expires ${escape(date(data.inviteExpiry))}</p>` : '<p class="muted">Generate a code to invite members. Codes expire after 24 hours.</p>'}${code ? `<code class="code">${escape(code)}</code>` : data.inviteExpiry ? '<p class="muted">Generate a new code if you need to share it again.</p>' : ''}
    <div class="actions">${button(data.inviteExpiry ? 'Generate new code' : 'Generate code','invite','','primary')}${code ? button('Copy code','copy-invite') + button('Share code','share-invite') : ''}${data.inviteExpiry ? button('Revoke','revoke','','danger') : ''}</div></section>` : ''}
    <section class="card">${head('Your account')}<div class="actions">${button('Create household','create')}${button('Join household','join')}${button('Log out','signout')}</div></section></div>`;
}
function render() {
  nav.hidden = !data;
  if (!account) {
    switcher.innerHTML = '';
    main.innerHTML = title('HomeHub','A shared space for your household.') + `<section class="card stack">
      ${signInError ? '<p class="form-error" role="alert">' + escape(signInError) + '</p>' : ''}
      ${configured ? (emailForCode
        ? '<p>Enter the code sent to ' + escape(emailForCode) + '.</p>' +
          form(input('Email code','code','','required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}" maxlength="10"'),'Verify code','data-form="verify-code"') +
          '<div class="actions">' + button('Resend code','resend-code') + button('Change email','change-email') + '</div>'
        : form(input('Email address','email','','required type="email" autocomplete="email" maxlength="254"'),'Email me a code','data-form="send-code"'))
        : '<p>Set the Supabase URL and publishable key to enable sign-in.</p>'}
    </section>`;
    return;
  }
  const householdOptions = account.households.map(h => [h.id,h.name]);
  switcher.innerHTML = householdOptions.length ? `<select aria-label="Switch household" id="household-switch">${options(householdOptions,selected)}</select>` : '';
  if (!data) {
    main.innerHTML = title('Welcome to HomeHub','Create a household or enter an invitation code from an admin.') + `<section class="card"><div class="actions">${button('Create household','create','','primary')}${button('Join household','join')}${button('Log out','signout')}</div></section>`;
    return;
  }
  const currentTab = tab();
  nav.innerHTML = tabs.map(([key,name,icon]) => `<a href="#${key}"${key === currentTab ? ' aria-current="page"' : ''}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="${icon}"/></svg>${name}</a>`).join('');
  main.innerHTML = {overview,order:ordering,work,contacts,household}[currentTab]();
}
function modal(label,fields,action,id='',target='') {
  dialog.innerHTML = head(label,button('Close','close')) + form(fields,'Save',`data-form="${action}" data-id="${escape(id)}" data-target="${target}"`);
  dialog.showModal();
}
function taskModal(task={}) {
  modal(task.id ? 'Edit Work' : 'Add Work',
    input('Description','description',task.description,'required maxlength="240"') +
    select('Assigned member','assignee',members('Unassigned'),task.assignee || '') +
    select('Status','status',statuses.map(status => [status,status]),task.status || 'Pending') +
    select('Linked contact','contact',[['','No contact'],...data.contacts.map(contact => [contact.id,contact.name])],task.contact || '') +
    input('Due date','due',task.due,'type="date"'),'record',task.id,'tasks');
}
function contactModal(contact={}) {
  modal(contact.id ? 'Edit Contact' : 'Add Contact',
    input('Name or service','name',contact.name,'required maxlength="100"') +
    input('Phone number','phone',contact.phone,'required type="tel" maxlength="40"') +
    `<label>Notes<textarea name="notes" maxlength="500" rows="3">${escape(contact.notes)}</textarea></label>`,'record',contact.id,'contacts');
}
function pasteList() {
  return groups(current()).map(([,item]) => item.name + ' — ' + item.quantity).join('\n');
}
async function copy(value) {
  await navigator.clipboard.writeText(value);
  toast('Copied');
}
function confirmDelete(label,segment) {
  modal(label,'<p>This action removes the record from the household.</p>','delete','',segment);
  dialog.querySelector('[type=submit]').textContent = 'Remove';
}
document.addEventListener('click', async event => {
  const control = event.target.closest('[data-action]');
  if (!control) return;
  const {action,value} = control.dataset;
  let changed = false;
  control.disabled = true;
  try {
    if (action === 'resend-code') {
      await sendCode(emailForCode);
      toast('A new code was sent.');
      return;
    }
    if (action === 'change-email') {
      emailForCode = null;
      render();
      return;
    }
    if (action === 'signout') return await signOut();
    if (action === 'retry') return await refresh();
    if (action === 'close') return dialog.close();
    if (action === 'create') return modal('Create household',input('Household name','name','','required maxlength="80"'),'create');
    if (action === 'join') return modal('Join household',input('Invitation code','code','','required maxlength="40" autocomplete="off"'),'join');
    if (action === 'add-item' || action === 'edit-item') return modal(value ? 'Edit Item' : 'Add Item',itemFields(data.items.find(item => item.id === value)), 'item',value);
    if (action === 'add-task' || action === 'edit-task') return taskModal(data.tasks.find(item => item.id === value));
    if (action === 'add-contact' || action === 'edit-contact') return contactModal(data.contacts.find(item => item.id === value));
    if (action.startsWith('delete-')) return confirmDelete('Delete ' + action.slice(7) + '?',({item:'items',task:'tasks',contact:'contacts'}[action.slice(7)]) + '/' + encodeURIComponent(value));
    if (action === 'remove-member') return confirmDelete('Remove member?', 'members/' + encodeURIComponent(value));
    if (action === 'copy-list') return await copy(pasteList());
    if (action === 'copy-phone') return await copy(data.contacts.find(contact => contact.id === value).phone);
    if (action === 'copy-invite') return await copy(invite.code);
    if (action === 'share-invite') return navigator.share ? await navigator.share({title:'HomeHub invitation',text:'HomeHub invitation code: ' + invite.code}) : await copy(invite.code);
    if (action === 'whatsapp') return window.open('https://wa.me/?text=' + encodeURIComponent(pasteList()),'_blank','noopener,noreferrer');
    if (action === 'order-all' || action === 'order-group') {
      const ids = current().filter(item => action === 'order-all' || item.item_key === value).map(item => item.id);
      await api(path('order'),'POST',{ids});
      toast('Marked as ordered. Undo is available in Ordered history.');
      changed = true;
    }
    if (action === 'undo') { await api(path('undo/' + encodeURIComponent(value)),'POST'); changed = true; toast('Requests returned to the shopping list.'); }
    if (action === 'invite') { invite = await api(path('invite'),'POST'); changed = true; }
    if (action === 'revoke') { await api(path('invite'),'DELETE'); invite = null; changed = true; }
    if (action === 'rotate') { await api(path('rotate'),'POST'); changed = true; }
    if (action === 'role') {
      await api(path('members/' + encodeURIComponent(value)),'PATCH',{role:data.members.find(member => member.uid === value).role === 'admin' ? 'member' : 'admin'});
      changed = true;
    }
    if (changed) await refresh();
  } catch (error) {
    if (error.name !== 'AbortError') toast(error.message);
  } finally { control.disabled = false; }
});
document.addEventListener('submit', async event => {
  const element = event.target;
  if (!element.matches('[data-form]')) return;
  event.preventDefault();
  const {form:action,id,target} = element.dataset;
  const values = Object.fromEntries(new FormData(element));
  const submit = element.querySelector('[type=submit]');
  const errorText = element.querySelector('.form-error');
  submit.disabled = true;
  errorText.hidden = true;
  try {
    if (action === 'send-code') {
      const email = values.email.trim();
      await sendCode(email);
      emailForCode = email;
      render();
      return;
    }
    if (action === 'verify-code') {
      await verifyCode(emailForCode,values.code.trim());
      return;
    }
    if (action === 'create' || action === 'join') {
      const result = await api(base + (action === 'join' ? '/join' : ''),'POST',values);
      if (selected !== result.id) { invite = null; expanded.clear(); search = ''; }
      selected = result.id;
      location.hash = '#overview';
    }
    if (action === 'item') {
      await api(path('items' + (id ? '/' + encodeURIComponent(id) : '')),id ? 'PATCH' : 'POST',{...values,quantity:Number(values.quantity)});
      if (!dialog.open) element.reset();
    }
    if (action === 'record') await api(path(target + (id ? '/' + encodeURIComponent(id) : '')),id ? 'PATCH' : 'POST',values);
    if (action === 'settings') await api(path('settings'),'PATCH',values);
    if (action === 'delete') await api(path(target),'DELETE');
    if (dialog.open) dialog.close();
    await refresh();
    toast(action === 'delete' ? 'Removed' : 'Saved');
  } catch (error) {
    errorText.textContent = error.message;
    errorText.hidden = false;
  } finally { submit.disabled = false; }
});
document.addEventListener('change',event => {
  if (event.target.id !== 'household-switch') return;
  selected = event.target.value;
  invite = data = null;
  expanded.clear();
  search = '';
  nav.hidden = true;
  main.innerHTML = title('HomeHub') + '<p role="status">Loading household…</p>';
  refresh();
});
document.addEventListener('input',event => {
  if (event.target.name !== 'search') return;
  search = event.target.value;
  document.querySelector('#contact-rows').innerHTML = contactRows();
});
document.addEventListener('toggle',event => {
  const key = event.target.dataset?.key;
  if (key != null) event.target.open ? expanded.add(key) : expanded.delete(key);
},true);
window.addEventListener('hashchange',() => { render(); window.scrollTo(0,0); });
document.addEventListener('visibilitychange',() => { if (!document.hidden && sessionUser) refresh(true); });
setInterval(() => { if (!document.hidden && sessionUser) refresh(true); },12000);
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register(new URL(import.meta.env.BASE_URL + 'sw.js',location.origin)).catch(() => {});
}
const callback = new URLSearchParams(location.search);
const callbackError = callback.get('error_description') || callback.get('error');
if (callbackError) {
  signInError = 'Email sign-in could not complete. Please try again.';
  history.replaceState(null,'',location.pathname);
}
if (configured) {
  observeSession((user,event) => {
    if (event === 'TOKEN_REFRESHED') return;
    const uid = user?.id ?? null;
    if (uid === sessionUser && event !== 'INITIAL_SESSION') return;
    sessionUser = uid;
    ++requestVersion;
    account = data = selected = snapshot = invite = null;
    expanded.clear();
    search = '';
    if (dialog.open) dialog.close();
    watchChanges(uid,() => { if (uid && uid === sessionUser) void refresh(true); });
    if (uid) {
      signInError = emailForCode = null;
      void refresh();
    } else {
      render();
    }
  });
} else {
  render();
}
