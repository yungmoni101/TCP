// Mobile Menu Toggle
document.addEventListener('DOMContentLoaded', function() {
    // Add mobile menu button if not exists
    const navbar = document.querySelector('.navbar .container');
    if (navbar && !document.querySelector('.mobile-menu-toggle')) {
        const menuToggle = document.createElement('button');
        menuToggle.className = 'mobile-menu-toggle';
        menuToggle.innerHTML = '☰';
        menuToggle.setAttribute('aria-label', 'Toggle menu');
        navbar.insertBefore(menuToggle, navbar.children[1]);
        
        // Toggle menu on click
        menuToggle.addEventListener('click', function() {
            const navMenu = document.querySelector('.nav-menu');
            const navBrand = document.querySelector('.nav-brand');
            navMenu.classList.toggle('active');
            this.classList.toggle('active');
            this.innerHTML = this.classList.contains('active') ? '✕' : '☰';
            
            // Hide logo when menu is active
            if (navMenu.classList.contains('active')) {
                navBrand.style.display = 'none';
            } else {
                navBrand.style.display = 'block';
            }
        });
    }
    
    // Handle dropdown toggles on mobile
    const dropdowns = document.querySelectorAll('.dropdown > a');
    dropdowns.forEach(function(dropdown) {
        dropdown.addEventListener('click', function(e) {
            if (window.innerWidth <= 768) {
                e.preventDefault();
                const parent = this.parentElement;
                parent.classList.toggle('active');
            }
        });
    });
    
    // Close menu when clicking outside
    document.addEventListener('click', function(e) {
        const navbar = document.querySelector('.navbar');
        const menuToggle = document.querySelector('.mobile-menu-toggle');
        const navMenu = document.querySelector('.nav-menu');
        const navBrand = document.querySelector('.nav-brand');
        
        if (navMenu && navMenu.classList.contains('active') && 
            !navbar.contains(e.target)) {
            navMenu.classList.remove('active');
            if (menuToggle) {
                menuToggle.classList.remove('active');
                menuToggle.innerHTML = '☰';
            }
            if (navBrand) {
                navBrand.style.display = 'block';
            }
        }
    });
    
    // Services Carousel Functionality
    const carousel = document.querySelector('.services-carousel');
    const cards = carousel ? carousel.querySelectorAll('.service-card-new') : [];
    const prevBtn = document.querySelector('.carousel-prev');
    const nextBtn = document.querySelector('.carousel-next');
    const currentSlideSpan = document.querySelector('.current-slide');
    let currentSlide = 0;
    
    function updateCarousel() {
        cards.forEach((card, index) => {
            card.classList.remove('active');
            if (index === currentSlide) {
                card.classList.add('active');
            }
        });
        if (currentSlideSpan) {
            currentSlideSpan.textContent = currentSlide + 1;
        }
    }
    
    function nextSlide() {
        currentSlide = (currentSlide + 1) % cards.length;
        updateCarousel();
    }
    
    function prevSlide() {
        currentSlide = (currentSlide - 1 + cards.length) % cards.length;
        updateCarousel();
    }
    
    // Initialize carousel on page load
    if (cards.length > 0) {
        updateCarousel();
    }
    
    // Add event listeners
    if (nextBtn) {
        nextBtn.addEventListener('click', nextSlide);
    }
    if (prevBtn) {
        prevBtn.addEventListener('click', prevSlide);
    }
});

