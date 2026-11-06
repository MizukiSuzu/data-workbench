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
let fileStem = 'data'

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
  renderSuggestions()
  rankResults.textContent = 'Your ranking will appear here.'
  rankResults.className = 'bg-white border border-gray-200 rounded-xl p-4 md:p-6 text-gray-400 text-sm mb-6'
  delete rankResults.dataset.done
}

// --- API calls with a busy indicator ---

const busyToast = document.getElementById('busy')
const busyText = document.getElementById('busy-text')
let busy = false

// One request at a time: a second click while busy is ignored, which also
// stops two cleans (or a clean and an undo) racing on the same dataset.
async function postForm(url, form, label, asBlob = false) {
  busy = true
  busyText.textContent = label
  busyToast.classList.remove('hidden')
  document.body.classList.add('cursor-progress')
  // The first request after the site idles waits for the Python server to start
  const slow = setTimeout(() => { busyText.textContent = `${label} Waking up the server, this can take a few seconds.` }, 1500)
  try {
    const res = await fetch(url, { method: 'POST', body: form })
    if (res.status === 413) throw new Error('This dataset is too large. Files up to about 4 MB work best.')
    if (res.ok && asBlob) return res.blob()
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
    currentSource.textContent = data.note ? `${file.name}. ${data.note}.` : file.name
    fileStem = file.name.replace(/\.[^.]+$/, '')
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
  setOptions(document.getElementById('rank-target'), [NO_GOAL, ...dataset.column_names])
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

// The working dataset as a form: Vercel functions keep no state, so it goes back up as CSV
function datasetForm() {
  const form = new FormData()
  form.append('file', new Blob([toCsv()], { type: 'text/csv' }), 'data.csv')
  form.append('dates', JSON.stringify(dataset.stats.filter(s => s.dtype.startsWith('datetime')).map(s => s.name)))
  return form
}

function download(blob, extension) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${fileStem}${undoStack.length ? '_cleaned' : ''}.${extension}`
  a.click()
  URL.revokeObjectURL(a.href)
}

document.querySelectorAll('[data-export]').forEach(btn =>
  btn.addEventListener('click', async () => {
    if (!dataset) return alert('Load a dataset first.')
    if (btn.dataset.export === 'csv') return download(new Blob([toCsv()], { type: 'text/csv' }), 'csv')
    if (busy) return
    try {
      download(await postForm('/api/export', datasetForm(), 'Building your Excel file…', true), 'xlsx')
    } catch (err) {
      alert(err.message)
    }
  })
)


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
  const form = datasetForm()
  form.append('action', action)
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

function renderSuggestions() {
  const total = (key, numeric) => dataset.stats
    .filter(s => ('mean' in s) === numeric)
    .reduce((sum, s) => sum + (s[key] || 0), 0)
  const suggestions = [
    [dataset.duplicates, 'dedupe', `${dataset.duplicates} duplicate rows`, 'Remove duplicates'],
    [dataset.untrimmed, 'trim', `${dataset.untrimmed} text cells have stray spaces`, 'Trim whitespace'],
    [total('missing', true), 'fill_median', `${total('missing', true)} empty number cells. The median is safer than the mean when outliers exist`, 'Fill with median'],
    [total('missing', false), 'fill_mode', `${total('missing', false)} empty text cells`, 'Fill with most common'],
    [total('outliers', true), 'remove_outliers', `${total('outliers', true)} unusual values. They may be real, so check them first`, 'Remove outlier rows'],
  ].filter(([count]) => count > 0)

  const list = document.getElementById('suggestion-list')
  list.innerHTML = suggestions.length
    ? suggestions.map(([, action, text, label]) => `<div class="flex flex-wrap items-center justify-between gap-2 py-2 border-t border-gray-100 first:border-t-0">
        <span class="text-gray-700">${escapeHtml(text)}</span>
        <button data-suggest="${action}" class="px-3 py-1.5 border border-gray-300 bg-white rounded-lg hover:bg-gray-50">${escapeHtml(label)}</button>
      </div>`).join('')
    : '<span class="text-green-700">No common problems found.</span>'
}

document.getElementById('suggestion-list').addEventListener('click', e => {
  const btn = e.target.closest('[data-suggest]')
  if (btn) runClean(btn.dataset.suggest)
})

undoButton.addEventListener('click', () => {
  if (busy) return
  const last = undoStack.pop()
  if (!last) return
  renderSummary(last.dataset)
  undoButton.disabled = undoStack.length === 0
  logClean(`Undid: ${last.message}`)
})


// --- Rank columns ---

const NO_GOAL = '(no goal: check data quality)'
const rankResults = document.getElementById('rank-results')

function rankRow(row, i, goal) {
  // A direction means nothing when there is barely any relationship
  const directions = { up: `Rises as ${goal} rises.`, down: `Falls as ${goal} rises.` }
  const direction = row.score >= 0.1 ? directions[row.direction] || '' : ''
  return `<div class="py-3 border-t border-gray-100 first:border-t-0">
    <div class="flex flex-wrap items-baseline justify-between gap-x-3">
      <span class="font-semibold text-gray-900">${i + 1}. ${escapeHtml(row.name)}</span>
      <span class="text-gray-700">${row.score.toFixed(2)} (${escapeHtml(row.label)})</span>
    </div>
    <div class="h-2 bg-gray-100 rounded-full my-2"><div class="h-2 bg-blue-600 rounded-full" style="width:${Math.round(row.score * 100)}%"></div></div>
    <p class="text-gray-500">${escapeHtml(row.method)}. ${escapeHtml(direction)}</p>
  </div>`
}

function renderRank(result) {
  const goal = result.target
  const heading = goal ? `Most to least related to "${goal}"` : 'Most to least usable columns'
  const caution = goal
    ? 'Related does not mean one column causes the other.'
    : 'This rates how complete and varied each column is, not how much it matters. Pick a goal column to see what relates to it.'
  const left = result.excluded.map(c => `<li><span class="font-semibold">${escapeHtml(c.name)}</span>: ${escapeHtml(c.reason)}</li>`).join('')
  rankResults.className = 'bg-white border border-gray-200 rounded-xl p-4 md:p-6 text-sm mb-6'
  rankResults.innerHTML = `<h2 class="text-lg font-semibold mb-1">${escapeHtml(heading)}</h2>
    <p class="text-gray-500 mb-3">${escapeHtml(caution)}</p>
    ${result.ranked.map((row, i) => rankRow(row, i, goal)).join('') || '<p class="text-gray-500">No columns could be scored.</p>'}
    ${left ? `<h3 class="font-semibold mt-4 mb-1">Left out</h3><ul class="text-gray-500 list-disc pl-5">${left}</ul>` : ''}`
  rankResults.dataset.done = 'true'
}

document.getElementById('rank-run').addEventListener('click', async () => {
  if (busy) return
  if (!dataset) {
    rankResults.textContent = 'Load a dataset first.'
    return
  }
  const form = datasetForm()
  const target = document.getElementById('rank-target').value
  if (target !== NO_GOAL) form.append('target', target)
  try {
    renderRank(await postForm('/api/rank', form, 'Ranking columns…'))
  } catch (err) {
    rankResults.className = 'bg-red-50 text-red-600 rounded-xl p-4 md:p-6 text-sm mb-6'
    rankResults.textContent = err.message
  }
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


// --- Guide ---

const guideCard = document.getElementById('guide-card')
const guidePrompt = document.getElementById('guide-prompt')
const guideNext = document.getElementById('guide-next')
const guideDo = document.getElementById('guide-do')
const GUIDE_SEEN_KEY = 'data-workbench-guide-seen'

function pickNumericColumn(preferred) {
  const numeric = numericColumns()
  return numeric.includes(preferred) ? preferred : numeric.find(n => !/id$/i.test(n)) || numeric[0]
}

// Steps with `wait` ask the user to try something, and `doIt` does it for them.
// `required` steps must finish first, because the rest of the tour needs data loaded.
const guideSteps = [
  { tab: 'tab-upload', title: 'Welcome to Data Workbench', text: 'This tour takes about 2 minutes. You will load data, find its problems, fix them, find patterns and download the result. You can close it at any time.' },
  { tab: 'tab-upload', target: '#load-sample', title: 'Load some data', text: 'Click "Try sample data" to load 244 made-up coffee shop orders. Later you can use your own CSV, JSON, Excel, Word or PDF file.', required: true, wait: () => dataset !== null, doIt: () => document.getElementById('load-sample').click() },
  { tab: 'tab-upload', target: '#preview-card', title: 'Check it loaded correctly', text: 'Each column is one kind of information and each row is one order. A dash marks an empty cell. Real data usually has some.' },
  { tab: 'tab-summary', target: '#stats-cards', title: 'Get the big picture', text: 'Start with the size of your data and how many cells are empty. Many empty cells can make results less reliable.' },
  { tab: 'tab-summary', target: '#stats-table', title: 'Look at each column', text: 'If the mean and median are far apart, a few extreme values are pulling on the average. The "What do these columns mean?" section below explains every term.' },
  { tab: 'tab-clean', target: '#clean-suggestions', title: 'See what needs fixing', text: 'The app checks your data and lists common problems. It only ever changes your working copy, never your original file.' },
  { tab: 'tab-clean', target: '[data-action="dedupe"]', title: 'Fix a problem', text: 'Duplicate rows count the same order twice. Click "Remove duplicates" to drop them.', wait: start => undoStack.length > start.undo, doIt: () => document.querySelector('[data-action="dedupe"]').click() },
  { tab: 'tab-clean', target: '#undo-clean', title: 'Mistakes are safe', text: 'Every cleaning action can be undone, one step at a time, so you are free to experiment.' },
  { tab: 'tab-rank', target: '#rank-controls', title: 'Find what matters', text: 'Choose the column you care about, such as "total", then click "Rank columns". The app scores how closely every other column relates to it.', wait: () => rankResults.dataset.done === 'true', doIt: () => {
    const goal = pickNumericColumn('total')
    if (goal) document.getElementById('rank-target').value = goal
    document.getElementById('rank-run').click()
  } },
  { tab: 'tab-rank', target: '#rank-results', title: 'Read the ranking', text: 'Longer bars mean a closer relationship. Treat it as a lead to investigate: related does not mean one column causes the other.' },
  { tab: 'tab-visualize', target: '#viz-controls', title: 'Draw a chart', text: 'Charts show patterns that numbers hide. Choose a chart type and a column, then click "Draw chart".', wait: () => chartArea.querySelector('canvas, table') !== null, doIt: () => {
    const column = pickNumericColumn('total')
    document.getElementById('chart-type').value = 'histogram'
    if (column) document.getElementById('col-x').value = column
    drawChart()
  } },
  { tab: 'tab-clean', target: '#clean-export', title: 'Take your data with you', text: 'Download your cleaned data as CSV or Excel. That is the whole workflow. Reopen this guide from the Guide button at any time.' },
]

let guideIndex = 0
let guideTimer = null
let guideStart = null
let guideHighlighted = null

function clearGuideHighlight() {
  if (guideHighlighted) guideHighlighted.classList.remove('guide-target')
  guideHighlighted = null
}

function updateGuideButtons() {
  const step = guideSteps[guideIndex]
  const last = guideIndex === guideSteps.length - 1
  const waiting = step.wait && !step.wait(guideStart)
  guideDo.classList.toggle('hidden', !waiting)
  guideNext.disabled = Boolean(waiting && step.required)
  guideNext.textContent = last ? 'Finish' : waiting && !step.required ? 'Skip this step' : 'Next'
}

function showGuideStep(index) {
  guideIndex = index
  const step = guideSteps[index]
  guideStart = { undo: undoStack.length }
  showTab(step.tab)
  clearGuideHighlight()
  if (step.target) {
    guideHighlighted = document.querySelector(step.target)
    guideHighlighted.classList.add('guide-target')
    const tall = guideHighlighted.offsetHeight > window.innerHeight * 0.5
    guideHighlighted.scrollIntoView({ block: tall ? 'start' : 'center' })
  } else {
    window.scrollTo(0, 0)
  }
  document.getElementById('guide-progress').textContent = `Step ${index + 1} of ${guideSteps.length}`
  document.getElementById('guide-title').textContent = step.title
  document.getElementById('guide-text').textContent = step.text
  document.getElementById('guide-back').classList.toggle('hidden', index === 0)
  updateGuideButtons()
  guideNext.focus({ preventScroll: true })
}

function markGuideSeen() {
  guidePrompt.classList.add('hidden')
  try { localStorage.setItem(GUIDE_SEEN_KEY, 'true') } catch {}
}

function openGuide() {
  markGuideSeen()
  guideCard.classList.remove('hidden')
  document.body.classList.add('guide-open')
  showGuideStep(0)
  guideTimer = setInterval(updateGuideButtons, 300)
}

function closeGuide() {
  clearInterval(guideTimer)
  clearGuideHighlight()
  guideCard.classList.add('hidden')
  document.body.classList.remove('guide-open')
}

document.getElementById('guide-open').addEventListener('click', openGuide)
document.getElementById('guide-prompt-start').addEventListener('click', openGuide)
document.getElementById('guide-prompt-dismiss').addEventListener('click', markGuideSeen)
document.getElementById('guide-close').addEventListener('click', closeGuide)
document.getElementById('guide-back').addEventListener('click', () => showGuideStep(guideIndex - 1))
guideDo.addEventListener('click', () => guideSteps[guideIndex].doIt())
guideNext.addEventListener('click', () => {
  if (guideIndex === guideSteps.length - 1) return closeGuide()
  showGuideStep(guideIndex + 1)
})
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !guideCard.classList.contains('hidden')) closeGuide()
})

let guideSeen = false
try { guideSeen = localStorage.getItem(GUIDE_SEEN_KEY) === 'true' } catch {}
if (!guideSeen) guidePrompt.classList.remove('hidden')
