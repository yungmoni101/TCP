# TCP Immigration Services - Static HTML Website

This folder contains a fully functional static HTML version of the TCP Immigration Services website, converted from the original React single-page application.

## 📁 Files Included

### Main Pages
- **index.html** - Home page with hero section, services overview, and call-to-action
- **about.html** - About the company, team, mission, and values
- **services.html** - Complete list of all immigration services
- **faqs.html** - Frequently asked questions with interactive accordion
- **process.html** - Step-by-step explanation of the immigration process

### Service Detail Pages
1. **service-visiting.html** - Visiting Canada (visitor visas, super visas, extensions)
2. **service-studying.html** - Studying in Canada (study permits, PGWP)
3. **service-working.html** - Working in Canada (work permits, LMIA)
4. **service-pr.html** - Permanent Residence (Express Entry, PNP, Quebec)
5. **service-family.html** - Family Reunification (spousal sponsorship, parents/grandparents)
6. **service-business.html** - Business & Investment (start-up visa, entrepreneur programs)
7. **service-citizenship.html** - Citizenship & PR Cards (citizenship applications, renewals)
8. **service-humanitarian.html** - Humanitarian & Compassionate (H&C applications)
9. **service-refusals.html** - Refusals & Complex Cases (appeals, judicial reviews)

### Styling
- **styles.css** - Complete CSS stylesheet with responsive design

## ✨ Features

### Fully Functional
- ✅ Working navigation menu with dropdown for services
- ✅ Responsive design (mobile, tablet, desktop)
- ✅ Interactive FAQ accordion (JavaScript included)
- ✅ Contact form with validation (displays alert - needs backend to actually send)
- ✅ All internal links properly connected
- ✅ Professional design matching original site theme

### Design Elements
- Custom color scheme (primary blue, secondary red)
- Modern CSS with gradients and shadows
- Clean typography and spacing
- Card-based layout for services
- Hero sections on each page
- Consistent header and footer across all pages

## 🚀 How to Use

1. **Open in Browser**: Simply double-click `index.html` to open the website in your default browser
2. **Navigation**: Use the navigation menu to browse between pages
3. **Test Locally**: All pages work without a server - pure static HTML

## 🔗 Internal Links

All internal links use relative paths and work perfectly:
- Home: `index.html`
- About: `about.html`
- Services: `services.html`
- Individual services: `service-*.html`
- FAQs: `faqs.html`
- Process: `process.html`
- Contact: `contact.html`

## 📱 Responsive Design

The website is fully responsive and works on:
- Desktop computers (1200px+)
- Tablets (768px - 1199px)
- Mobile phones (< 768px)

## ⚠️ Important Notes

### Contact Form
The contact form includes client-side validation and displays an alert when submitted. To make it fully functional, you'll need to:
- Add a backend service (PHP, Node.js, etc.)
- Or use a form service like Formspree, Netlify Forms, etc.
- Update the form action attribute

### Images
The current version uses emoji icons (🎓, 💼, 🏠, etc.) instead of image files. If you want to add images:
1. Create an `images/` folder
2. Add your images
3. Update the `<img>` tags in the HTML

### Deployment
To deploy this website:
1. Upload all HTML files and styles.css to your web hosting
2. Keep the folder structure intact
3. No server-side processing required - works with any static hosting (GitHub Pages, Netlify, Vercel, etc.)

## 🎨 Customization

### To Change Colors
Edit the CSS variables in `styles.css`:
```css
:root {
    --primary: hsl(220, 60%, 25%);      /* Blue */
    --secondary: hsl(0, 75%, 45%);      /* Red */
}
```

### To Update Contact Information
Search for and replace:
- Phone: `+1 581-203-1198`
- Email: `info@tcpimmigration.ca`
- Address: `220 4 Ave SE #230, Calgary, AB T2G 4X3, Canada`
- RCIC: `R1040879`

### To Add More Pages
1. Copy an existing HTML file as a template
2. Update the content
3. Add links to the navigation menu in all pages

## 📄 Browser Compatibility

Works in all modern browsers:
- Chrome/Edge (latest)
- Firefox (latest)
- Safari (latest)
- Opera (latest)

## 💡 Tips

- Keep all files in the same folder for links to work
- Open `index.html` as the starting point
- The dropdown menu appears on hover
- FAQ items expand/collapse on click
- All pages have consistent navigation

## 📞 Support

If you need modifications or have questions about the website, contact TCP Immigration Services at:
- Phone: +1 581-203-1198
- Email: info@tcpimmigration.ca

---

## 💳 Payment Links (PayLink)

This site includes a self-serve **payment link** system so clients can pay immigration
fees via bank transfer, with live currency conversion to CAD.

### What it does
- **Admin dashboard** (`admin.html`) — create/delete payment links, set the currency the
  client pays in (USD, NGN, EUR, GBP), configure the bank account they transfer to, and
  review submitted payments + receipts.
- **Client payment page** (`pay.html?slug=XXXX`) — client enters their name/email/phone/address,
  types an amount, sees the live **CAD** equivalent, picks **Pay with bank transfer**
  (card is shown as "currently not available"), then gets a 15-minute timer with the bank
  details and an upload-receipt box.

### Setup (one-time)
1. Create a free project at <https://supabase.com>.
2. Open **SQL Editor → New query**, paste the contents of `supabase/schema.sql`, and run it.
3. Go to **Project Settings → API** and copy the **Project URL** and the **anon / public key**.
4. Open `js/config.js` and paste those values into `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
   (These are browser-safe public keys — fine to ship in a static site.)
5. In the Supabase dashboard, create the first admin: **Authentication → Users → Add user**
   (or sign up from `admin.html`). Every signed-in user has full admin access.

### Files
- `pay.html` / `js/pay.js` — client payment flow
- `admin.html` / `js/admin.js` — admin dashboard
- `js/config.js` — Supabase credentials (edit me)
- `js/fx.js` — free live FX rates (Frankfurter API, no key needed)
- `css/payment.css` — payment + admin styles
- `supabase/schema.sql` — database + storage + security rules

### Currency
The business always receives **CAD**. In the admin dashboard you choose the currency the
client *pays in* (e.g. USD or NGN); the client sees the converted CAD amount before paying.
Rates come from the free Frankfurter API and are cached for 1 hour.

---

**Created**: 2024
**License**: Copyright © 2024 TCP Immigration Services Ltd. All rights reserved.
