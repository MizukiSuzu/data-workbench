const navLinks = document.querySelectorAll('[data-tab]')
const sections = document.querySelectorAll('section')

navLinks.forEach(link => {
  link.addEventListener('click', function(e) {
    e.preventDefault()

    // Hide all sections
    sections.forEach(section => {
      section.classList.add('hidden')
    })

    // Remove active from all links
    navLinks.forEach(l => {
      l.classList.remove('active')
    })

    // Show the clicked tab
    const tabId = this.getAttribute('data-tab')
    document.getElementById(tabId).classList.remove('hidden')

    // Mark this link as active
    this.classList.add('active')
  })
})

// Set Load Data as active on page load
document.querySelector('[data-tab="tab-upload"]').classList.add('active')

// --- Upload + summary ---

const fileInput = document.getElementById('file-input')
const dropZone = document.getElementById('drop-zone')
const currentSource = document.getElementById('current-source')
const previewTable = document.getElementById('preview-table')
const statsTable = document.getElementById('stats-table')

let dataset = null  // last API response: the working copy of the data
let fileName = 'data.csv'

function showTab(tabId) {
  document.querySelector(`[data-tab="${tabId}"]`).click()
}

function escapeHtml(value) {
  if (value === null || value === undefined) return '<span class="text-gray-300">—</span>'
  const div = document.createElement('div')
  div.textContent = String(value)
  return div.innerHTML
}

function renderTable(headers, rows) {
  const head = headers.map(h => `<th class="px-4 py-2 text-left font-semibold">${escapeHtml(h)}</th>`).join('')
  const body = rows.map(row =>
    `<tr class="border-t border-gray-100">${row.map(v => `<td class="px-4 py-2">${escapeHtml(v)}</td>`).join('')}</tr>`
  ).join('')
  return `<table class="w-full text-sm text-left text-gray-700"><thead class="bg-gray-50"><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
}

function renderSummary(data) {
  dataset = data
  document.getElementById('stats-row').textContent = data.rows
  document.getElementById('stats-column').textContent = data.columns
  document.getElementById('stats-numeric').textContent = data.numeric
  document.getElementById('stats-missing').textContent = data.missing

  const cols = data.column_names
  previewTable.className = 'overflow-x-auto'
  previewTable.innerHTML = renderTable(cols, data.data.slice(0, 10).map(r => cols.map(c => r[c])))

  const keys = ['dtype', 'missing', 'unique', 'mean', 'std', 'min', 'median', 'max', 'outliers', 'top']
  statsTable.className = 'bg-white border border-gray-200 rounded-xl overflow-x-auto'
  statsTable.innerHTML = renderTable(['column', ...keys], data.stats.map(s => [s.name, ...keys.map(k => s[k])]))
  fillColumnSelects()
}

// --- API calls with a busy indicator ---

const busyToast = document.getElementById('busy')
const busyText = document.getElementById('busy-text')
let busy = false

// One request at a time: a second click while busy is ignored, which also
// stops two cleans (or a clean and an undo) racing on the same dataset.
async function postForm(url, form, label) {
  busy = true
  busyText.textContent = label
  busyToast.classList.remove('hidden')
  document.body.classList.add('cursor-progress')
  // The first request after the site idles waits for the Python server to start
  const slow = setTimeout(() => { busyText.textContent = `${label} Waking up the server, this can take a few seconds.` }, 1500)
  try {
    const res = await fetch(url, { method: 'POST', body: form })
    const data = await res.json().catch(() => ({ error: `Server error (${res.status}). Please try again.` }))
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
    return data
  } finally {
    clearTimeout(slow)
    busy = false
    busyToast.classList.add('hidden')
    document.body.classList.remove('cursor-progress')
  }
}

async function uploadFile(file) {
  if (busy) return
  currentSource.textContent = `Loading ${file.name}…`
  const form = new FormData()
  form.append('file', file)
  try {
    const data = await postForm('/api/summary', form, `Analyzing ${file.name}…`)
    currentSource.textContent = file.name
    fileName = file.name.replace(/\.json$/i, '.csv')
    document.getElementById('clean-log').innerHTML = ''
    undoStack.length = 0
    undoButton.disabled = true
    renderSummary(data)
  } catch (err) {
    currentSource.textContent = err.message
  }
}

dropZone.addEventListener('click', () => fileInput.click())
fileInput.addEventListener('change', () => fileInput.files[0] && uploadFile(fileInput.files[0]))
dropZone.addEventListener('dragover', e => e.preventDefault())
dropZone.addEventListener('drop', e => {
  e.preventDefault()
  if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0])
})
document.getElementById('run-analysis').addEventListener('click', () => showTab('tab-summary'))

document.getElementById('load-sample').addEventListener('click', async e => {
  e.stopPropagation()  // the button sits inside the drop zone, which opens the file picker
  if (busy) return
  const res = await fetch('/static/sample/coffee_sales.csv')
  uploadFile(new File([await res.blob()], 'coffee_sales.csv', { type: 'text/csv' }))
})


// --- Column selects ---

function numericColumns() {
  return dataset.stats.filter(s => 'mean' in s).map(s => s.name)
}

function setOptions(select, names) {
  const keep = select.value
  select.innerHTML = names.map(n => `<option>${escapeHtml(n)}</option>`).join('')
  if (names.includes(keep)) select.value = keep
}

function fillColumnSelects() {
  setOptions(document.getElementById('col-select'), dataset.column_names)
  setOptions(document.getElementById('col-x'), dataset.column_names)
  setOptions(document.getElementById('col-y'), ['(count)', ...numericColumns()])
}


// --- Export CSV ---

function toCsv() {
  const cols = dataset.column_names
  const cell = v => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [cols, ...dataset.data.map(r => cols.map(c => r[c]))].map(row => row.map(cell).join(',')).join('\n')
}

document.getElementById('export-csv').addEventListener('click', () => {
  if (!dataset) return alert('Load a dataset first.')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([toCsv()], { type: 'text/csv' }))
  a.download = fileName
  a.click()
  URL.revokeObjectURL(a.href)
})


// --- Clean ---

const cleanLog = document.getElementById('clean-log')
const undoButton = document.getElementById('undo-clean')
const undoStack = []  // earlier datasets and the action that replaced each, newest last

function logClean(text, isError) {
  const color = isError ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-700'
  cleanLog.insertAdjacentHTML('afterbegin', `<p class="${color} rounded-lg px-4 py-2 text-sm">${escapeHtml(text)}</p>`)
}

async function runClean(action, column, value) {
  if (busy) return
  if (!dataset) return logClean('Load a dataset first.', true)
  // Vercel functions keep no state, so the current data goes back up as CSV
  const form = new FormData()
  form.append('file', new Blob([toCsv()], { type: 'text/csv' }), 'data.csv')
  form.append('action', action)
  form.append('dates', JSON.stringify(dataset.stats.filter(s => s.dtype.startsWith('datetime')).map(s => s.name)))
  if (column) form.append('column', column)
  if (value) form.append('value', value)
  try {
    const data = await postForm('/api/clean', form, 'Cleaning…')
    // ponytail: unbounded undo history; cap it if people clean big files many times
    undoStack.push({ dataset, message: data.message })
    undoButton.disabled = false
    renderSummary(data)
    logClean(`${data.message} (now ${data.rows} rows, ${data.columns} columns)`)
  } catch (err) {
    logClean(err.message, true)
  }
}

document.querySelectorAll('[data-action]').forEach(btn =>
  btn.addEventListener('click', () => runClean(btn.dataset.action))
)
document.querySelectorAll('[data-column-action]').forEach(btn =>
  btn.addEventListener('click', () => {
    const renameInput = document.getElementById('rename-input')
    runClean(btn.dataset.columnAction, document.getElementById('col-select').value, renameInput.value)
    if (btn.dataset.columnAction === 'rename') renameInput.value = ''
  })
)

undoButton.addEventListener('click', () => {
  if (busy) return
  const last = undoStack.pop()
  if (!last) return
  renderSummary(last.dataset)
  undoButton.disabled = undoStack.length === 0
  logClean(`Undid: ${last.message}`)
})


// --- Visualize ---

const chartArea = document.getElementById('chart-area')
const chartTip = document.getElementById('chart-tip')
let chart = null

const chartTips = {
  histogram: 'Histograms show how one numeric column is spread across 10 equal-width bins.',
  bar: 'Bars show the row count per X value, or the mean of Y per X value (top 20).',
  scatter: 'Scatter plots show the relationship between two numeric columns.',
  correlation: 'Pearson correlation between numeric columns: blue is positive, red is negative.',
  missing: 'Empty cells per column. Use the Clean tab to fill or drop them.',
}

function showChartMessage(text) {
  chartArea.innerHTML = `<p class="text-gray-400">${escapeHtml(text)}</p>`
}

function histogram(values, bins = 10) {
  const min = Math.min(...values), max = Math.max(...values)
  const width = (max - min) / bins || 1
  const counts = Array(bins).fill(0)
  values.forEach(v => counts[Math.min(bins - 1, Math.floor((v - min) / width))]++)
  const labels = counts.map((_, i) => `${+(min + i * width).toFixed(2)} to ${+(min + (i + 1) * width).toFixed(2)}`)
  return { labels, counts }
}

function barData(x, y) {
  const groups = new Map()
  dataset.data.forEach(r => {
    const key = String(r[x] ?? '(missing)')
    if (!groups.has(key)) groups.set(key, [])
    if (y === '(count)' || r[y] !== null) groups.get(key).push(r[y])
  })
  const mean = vals => vals.reduce((a, b) => a + b, 0) / (vals.length || 1)
  // ponytail: top 20 groups only; more bars than that is unreadable anyway
  const rows = [...groups].map(([k, vals]) => [k, y === '(count)' ? vals.length : mean(vals)])
    .sort((a, b) => b[1] - a[1]).slice(0, 20)
  return { labels: rows.map(r => r[0]), values: rows.map(r => r[1]) }
}

function correlationTable() {
  const { columns, matrix } = dataset.correlation
  if (columns.length < 2) return showChartMessage('Need at least 2 numeric columns for a correlation heatmap.')
  const color = v => v === null ? '#f3f4f6'
    : `rgba(${v >= 0 ? '37, 99, 235' : '220, 38, 38'}, ${Math.abs(v)})`
  const head = columns.map(c => `<th class="px-3 py-2 font-semibold">${escapeHtml(c)}</th>`).join('')
  const body = matrix.map((row, i) => `<tr><th class="px-3 py-2 text-left font-semibold">${escapeHtml(columns[i])}</th>${
    row.map(v => `<td class="px-3 py-2 text-center ${Math.abs(v) > 0.5 ? 'text-white' : ''}" style="background:${color(v)}">${v === null ? '—' : v.toFixed(2)}</td>`).join('')
  }</tr>`).join('')
  chartArea.innerHTML = `<table class="text-sm m-auto"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table>`
}

function drawChart() {
  if (chart) { chart.destroy(); chart = null }
  if (!dataset) return showChartMessage('Load a dataset first.')

  const type = document.getElementById('chart-type').value
  const x = document.getElementById('col-x').value
  const y = document.getElementById('col-y').value
  const numeric = numericColumns()
  chartTip.textContent = chartTips[type]

  if (type === 'correlation') return correlationTable()

  let config
  if (type === 'missing') {
    if (!dataset.missing) return showChartMessage('No missing values. Nothing to plot.')
    config = { type: 'bar', data: { labels: dataset.column_names, datasets: [{ label: 'missing cells', data: dataset.stats.map(s => s.missing), backgroundColor: '#dc2626' }] } }
  } else if (type === 'histogram') {
    if (!numeric.includes(x)) return showChartMessage('Pick a numeric X column for a histogram.')
    const values = dataset.data.map(r => r[x]).filter(v => v !== null)
    if (!values.length) return showChartMessage(`'${x}' has no values.`)
    const h = histogram(values)
    config = { type: 'bar', data: { labels: h.labels, datasets: [{ label: x, data: h.counts, backgroundColor: '#2563eb', barPercentage: 1, categoryPercentage: 1 }] } }
  } else if (type === 'bar') {
    const b = barData(x, y)
    config = { type: 'bar', data: { labels: b.labels, datasets: [{ label: y === '(count)' ? 'count' : `mean ${y}`, data: b.values, backgroundColor: '#2563eb' }] } }
  } else {
    if (!numeric.includes(x) || !numeric.includes(y)) return showChartMessage('Pick numeric X and Y columns for a scatter plot.')
    const points = dataset.data.filter(r => r[x] !== null && r[y] !== null).map(r => ({ x: r[x], y: r[y] }))
    config = {
      type: 'scatter',
      data: { datasets: [{ label: `${y} vs ${x}`, data: points, backgroundColor: '#2563eb' }] },
      options: { scales: { x: { title: { display: true, text: x } }, y: { title: { display: true, text: y } } } },
    }
  }

  chartArea.innerHTML = '<canvas></canvas>'
  config.options = { maintainAspectRatio: false, ...config.options }
  chart = new Chart(chartArea.querySelector('canvas'), config)
}

document.getElementById('draw-chart').addEventListener('click', drawChart)
