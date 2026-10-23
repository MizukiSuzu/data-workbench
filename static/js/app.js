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
  document.getElementById('stats-row').textContent = data.rows
  document.getElementById('stats-column').textContent = data.columns
  document.getElementById('stats-numeric').textContent = data.numeric
  document.getElementById('stats-missing').textContent = data.missing

  const cols = data.column_names
  previewTable.className = 'overflow-x-auto'
  previewTable.innerHTML = renderTable(cols, data.preview.map(r => cols.map(c => r[c])))

  const keys = ['dtype', 'missing', 'unique', 'mean', 'std', 'min', 'median', 'max', 'top']
  statsTable.className = 'bg-white border border-gray-200 rounded-xl overflow-x-auto'
  statsTable.innerHTML = renderTable(['column', ...keys], data.stats.map(s => [s.name, ...keys.map(k => s[k])]))
}

async function uploadFile(file) {
  currentSource.textContent = `Loading ${file.name}…`
  const form = new FormData()
  form.append('file', file)
  try {
    const res = await fetch('/api/summary', { method: 'POST', body: form })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`)
    currentSource.textContent = file.name
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
