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