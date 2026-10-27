/**
 * Fictional CVs used only to render template thumbnails
 * (GET /api/v1/templates/:id/sample). Every template has one sample person:
 * a well-known public-domain literary character (Sherlock Holmes, Jane
 * Eyre, Ebenezer Scrooge...) with a career that suits the template. Only
 * public-domain characters — never trademarked modern ones. Never merged
 * into a user's CV.
 *
 * A sample is a character (name, contacts, home town, and references from
 * their own story) laid over a "body" of CV content for one profession.
 * Several templates can share a body; no two share a character.
 */

// A neutral silhouette (not a person) so photo templates show where the photo goes.
const SAMPLE_PHOTO = `data:image/svg+xml;utf8,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 150'><rect width='120' height='150' fill='#cfd8e1'/><circle cx='60' cy='58' r='26' fill='#8d9cad'/><path d='M12 150c4-34 24-52 48-52s44 18 48 52z' fill='#8d9cad'/></svg>"
)}`;

export type SampleCv = { personal: { title: string } & Record<string, unknown> } & Record<string, unknown>;

/** CV content for one profession, minus who it belongs to. `{me}` in any text becomes "J. Doe" for the character. */
type Body = { title: string } & Record<string, unknown>;

interface Character {
  name: string;
  email: string;
  phone: string;
  location: string;
  links?: { label: string; url: string }[];
  /** Replaces the body's headline when the character's version reads better. */
  title?: string;
  /** Any body section the character's story fills in better (references, personal details...). */
  overrides?: Record<string, unknown>;
  /** Tunes the body to this template's layout so the sample fills exactly one page. */
  fit?: Fit;
}

/**
 * The same body fills each template's page differently, so each sample is
 * trimmed or topped up until it fills exactly one page — no half-empty page,
 * nothing spilling onto a second. Applied after `overrides`.
 */
interface Fit {
  /** Keep only the first N items of these list sections ({ projects: 1 }; 0 drops it). */
  keep?: Record<string, number>;
  /** Items appended to list sections (a role, a reference...). */
  add?: Record<string, unknown[]>;
  /** How many bullets each role keeps, in order (roles past the end keep all). */
  bullets?: number[];
  /** Extra bullets for each role, in order. */
  moreBullets?: string[][];
}

function applyFit(content: Record<string, unknown>, fit: Fit | undefined): Record<string, unknown> {
  if (!fit) return content;
  const out = { ...content };
  for (const [key, items] of Object.entries(fit.add ?? {})) {
    out[key] = [...((out[key] as unknown[] | undefined) ?? []), ...items];
  }
  for (const [key, count] of Object.entries(fit.keep ?? {})) {
    if (Array.isArray(out[key])) out[key] = (out[key] as unknown[]).slice(0, count);
  }
  if ((fit.bullets || fit.moreBullets) && Array.isArray(out.experience)) {
    out.experience = (out.experience as { bullets?: unknown[] }[]).map((role, i) => {
      const kept = fit.bullets?.[i] === undefined ? (role.bullets ?? []) : (role.bullets ?? []).slice(0, fit.bullets[i]);
      const more = (fit.moreBullets?.[i] ?? []).map((text) => ({ text }));
      return { ...role, bullets: [...kept, ...more] };
    });
  }
  return out;
}

function replaceMe(value: unknown, me: string): unknown {
  if (typeof value === "string") return value.replaceAll("{me}", me);
  if (Array.isArray(value)) return value.map((v) => replaceMe(v, me));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceMe(v, me)]));
  }
  return value;
}

function sample(character: Character, body: Body): SampleCv {
  const { title, ...content } = body;
  const parts = character.name.split(" ");
  const me = parts.length > 1 ? `${parts[0][0]}. ${parts.slice(1).join(" ")}` : character.name;
  return replaceMe(
    {
      ...applyFit({ ...content, ...character.overrides }, character.fit),
      personal: {
        full_name: character.name,
        title: character.title ?? title,
        email: character.email,
        phone: character.phone,
        location: character.location,
        links: character.links ?? [{ label: "LinkedIn", url: "https://linkedin.com/in/example" }],
        photo: SAMPLE_PHOTO,
      },
    },
    me
  ) as SampleCv;
}

// ---------------------------------------------------------------------------
// Bodies — each carries about a page of content, as a template's own example
// would; each character's `fit` then sizes it to its template's exact page.
// Between them they cover every section some template shows.
// ---------------------------------------------------------------------------

const ENGINEER: Body = {
  title: "Full Stack Developer",
  summary:
    "Full stack developer with five years of experience building web applications in TypeScript, React, and Node.js. Comfortable owning features end to end, from database design and REST APIs to accessible, fast user interfaces.",
  skills: [],
  skillGroups: [
    { category: "Languages", items: ["TypeScript", "JavaScript", "Python", "SQL", "HTML", "CSS"] },
    { category: "Frameworks", items: ["React", "Next.js", "Node.js", "Express", "NestJS"] },
    { category: "Libraries", items: ["Redux", "React Query", "Tailwind CSS", "Prisma"] },
    { category: "Databases", items: ["PostgreSQL", "MongoDB", "Redis"] },
    { category: "Dev Tools", items: ["Git", "Docker", "GitHub Actions", "AWS", "Jest"] },
  ],
  experience: [
    {
      company: "Acme Software",
      location: "Remote",
      role: "Senior Software Engineer",
      start_date: "2023-04",
      end_date: "present",
      bullets: [
        { text: "Led the rebuild of the customer dashboard in Next.js, cutting median page load from 4.1s to 1.6s." },
        { text: "Designed a REST API and PostgreSQL schema for usage-based billing serving 12,000 accounts." },
        { text: "Introduced end-to-end tests in CI, reducing production regressions by 40% over two quarters." },
        { text: "Mentored three junior engineers through code review and weekly pairing sessions." },
      ],
    },
    {
      company: "Acme Software",
      location: "Remote",
      role: "Software Engineer",
      start_date: "2021-08",
      end_date: "2023-03",
      bullets: [
        { text: "Built the shared React component library used by four product teams." },
        { text: "Migrated background jobs from cron scripts to a Redis-backed queue with retries and monitoring." },
      ],
    },
    {
      company: "Example Studio",
      location: "Springfield, USA",
      role: "Backend Developer",
      start_date: "2019-06",
      end_date: "2021-07",
      bullets: [
        { text: "Developed Node.js services for booking and payments for retail and travel clients." },
        { text: "Fixed long-standing performance issues in reporting queries, making the slowest report 8x faster." },
      ],
    },
  ],
  education: [
    {
      institution: "Example State University",
      location: "Springfield, USA",
      degree: "B.Sc.",
      field: "Computer Science",
      gpa: "3.7/4.0",
      start_date: "2015-09",
      end_date: "2019-05",
    },
  ],
  projects: [
    {
      name: "Inventory Tracker",
      url: "https://github.com/example/inventory",
      tech: ["Next.js", "NestJS", "PostgreSQL"],
      bullets: [
        { text: "Offline-first inventory and sales platform used daily by a network of small retail stores." },
        { text: "Dashboards for stock levels, expiry alerts, and weekly sales reports." },
        { text: "Deployed with Docker on AWS, with GitHub Actions running tests on every pull request." },
      ],
    },
    {
      name: "Open Transit API",
      url: "https://github.com/example/transit",
      tech: ["Node.js", "Express", "Redis"],
      bullets: [
        { text: "Public REST API that normalizes city transit feeds into one schema; 300+ GitHub stars." },
        { text: "Caches real-time arrivals in Redis to serve 50 requests per second on a single small instance." },
      ],
    },
  ],
  certifications: [
    { name: "AWS Certified Developer – Associate", issuer: "Amazon Web Services", date: "2023-02" },
    { name: "Professional Scrum Master I", issuer: "Scrum.org", date: "2022-05" },
  ],
  languages: [
    { language: "English", proficiency: "Native" },
    { language: "Spanish", proficiency: "Professional working proficiency" },
  ],
  activities: [
    {
      title: "Organizer",
      organization: "University Coding Club",
      start_date: "2016-09",
      end_date: "2019-05",
      bullets: [{ text: "Ran weekly workshops and two student hackathons with 150 participants each." }],
    },
  ],
  interests: ["Open-source contributing", "Rock climbing", "Chess"],
};

const ANALYST: Body = {
  title: "Data Analyst",
  summary:
    "Data analyst with six years of experience turning messy operational data into forecasts, dashboards, and experiments that teams actually use. Known for clear writing, careful statistics, and building self-serve tools that free analysts for deeper work.",
  skills: [],
  skillGroups: [
    { category: "Programming", items: ["Python (pandas, scikit-learn)", "SQL", "R", "dbt"] },
    { category: "Data Analysis", items: ["Forecasting", "A/B testing", "Regression", "Cohort and funnel analysis"] },
    { category: "Visualization", items: ["Tableau", "Power BI", "Looker", "matplotlib"] },
    { category: "Data Platforms", items: ["BigQuery", "Snowflake", "Airflow", "Git"] },
  ],
  experience: [
    {
      company: "Northwind Retail",
      location: "Chicago, IL",
      role: "Senior Data Analyst",
      start_date: "2022-02",
      end_date: "present",
      bullets: [
        { text: "Built weekly demand forecasts for 40 stores that reduced overstock by 18% in the first year." },
        { text: "Replaced 12 manual spreadsheets with a self-serve sales dashboard used by 150 managers." },
      ],
    },
    {
      company: "Example Logistics",
      location: "Chicago, IL",
      role: "Data Analyst",
      start_date: "2019-06",
      end_date: "2022-01",
      bullets: [
        { text: "Automated route-cost reports with SQL and Python, saving the operations team a day each week." },
        { text: "Modeled delivery delays by region and carrier, leading to two renegotiated carrier contracts." },
      ],
    },
  ],
  projects: [
    {
      name: "City Bike Demand Model",
      subtitle: "Open-source forecasting notebook",
      tech: ["Python", "scikit-learn"],
      bullets: [{ text: "Predicts hourly bike-share demand from weather and events; featured at a local data meetup." }],
    },
  ],
  education: [
    {
      institution: "Example University",
      location: "Chicago, IL",
      degree: "M.S.",
      field: "Applied Statistics",
      start_date: "2017-09",
      end_date: "2019-05",
    },
    {
      institution: "Example University",
      location: "Chicago, IL",
      degree: "B.A.",
      field: "Economics",
      start_date: "2013-09",
      end_date: "2017-05",
    },
  ],
  certifications: [
    { name: "Data Analytics Professional Certificate", issuer: "Example Academy", date: "2021-09" },
    { name: "Tableau Desktop Specialist", issuer: "Tableau", date: "2020-11" },
  ],
  languages: [
    { language: "English", proficiency: "Native" },
    { language: "Spanish", proficiency: "Professional working proficiency" },
  ],
  interests: ["Urban cycling", "Data journalism", "Volunteer tutoring in statistics"],
  personalDetails: [
    { label: "Nationality", value: "American" },
    { label: "Driving licence", value: "Class D" },
  ],
  courses: [
    { name: "Machine Learning Specialization", institution: "Example Online Academy", date: "2023-03" },
    { name: "Advanced SQL for Analytics", institution: "Example Data School", date: "2021-02" },
  ],
  memberships: [{ organization: "Example Statistical Association", role: "Member", start_date: "2019" }],
};

const ACADEMIC: Body = {
  title: "Senior Lecturer in Computational Linguistics",
  summary:
    "Computational linguist working on multilingual language resources and machine translation for low-resource languages, with ten years of teaching and research supervision.",
  experience: [
    {
      company: "Example University",
      location: "Edinburgh, UK",
      role: "Senior Lecturer, School of Informatics",
      start_date: "2021-09",
      end_date: "present",
      bullets: [
        { text: "Lead the MSc module on natural language processing (120 students per year)." },
        { text: "Supervise four PhD students and twelve MSc dissertations on multilingual NLP." },
      ],
    },
    {
      company: "Example University",
      location: "Edinburgh, UK",
      role: "Lecturer, School of Informatics",
      start_date: "2017-09",
      end_date: "2021-08",
      bullets: [{ text: "Developed the undergraduate course on corpus linguistics and its online lab materials." }],
    },
    {
      company: "Sample Institute of Technology",
      location: "Manchester, UK",
      role: "Postdoctoral Researcher",
      start_date: "2015-01",
      end_date: "2017-08",
      bullets: [{ text: "Built bilingual lexicons for three low-resource languages within a funded EU project." }],
    },
  ],
  education: [
    {
      institution: "Example University",
      location: "Manchester, UK",
      degree: "Ph.D.",
      field: "Computer Science",
      start_date: "2010-10",
      end_date: "2014-12",
      bullets: [{ text: "Thesis: Pivot-based construction of multilingual lexicons for under-resourced languages." }],
    },
    {
      institution: "Example University",
      location: "Manchester, UK",
      degree: "M.Sc.",
      field: "Natural Language Processing",
      start_date: "2009-09",
      end_date: "2010-09",
      honors: "With distinction",
    },
    {
      institution: "Sample College",
      location: "Leeds, UK",
      degree: "B.A.",
      field: "Linguistics and Computer Science",
      start_date: "2006-09",
      end_date: "2009-06",
    },
  ],
  research: [
    {
      title: "Principal Investigator, Open Lexicons for Low-Resource Languages",
      organization: "Example Research Council",
      start_date: "2022-01",
      end_date: "present",
      bullets: [{ text: "Three-year grant building openly licensed dictionaries and evaluation sets for five languages." }],
    },
  ],
  teaching: [
    { title: "Natural Language Processing (MSc)", organization: "Example University", start_date: "2018-01", end_date: "present" },
    { title: "Corpus Linguistics (BSc, Year 3)", organization: "Example University", start_date: "2017-09", end_date: "present" },
  ],
  publications: [
    {
      authors: "{me}, J. Example, and R. Demo",
      title: "Pivot-based lexicon induction for under-resourced languages",
      venue: "Journal of Example Language Resources",
      date: "2023",
    },
    {
      authors: "{me} and C. Placeholder",
      title: "Evaluating machine translation for five low-resource languages",
      venue: "Proceedings of the Example Conference on Computational Linguistics",
      date: "2022",
    },
    {
      authors: "M. Demo and {me}",
      title: "A shared task on multilingual dictionary linking",
      venue: "Workshop on Example Lexical Resources",
      date: "2020",
    },
    {
      authors: "{me}",
      title: "Building bilingual lexicons from comparable corpora",
      venue: "Example Journal of Linguistics",
      date: "2017",
    },
  ],
  presentations: [
    { title: "Open lexicons as research infrastructure", event: "Example Digital Humanities Summit (keynote)", date: "2023-06" },
    { title: "Low-resource MT: what the benchmarks miss", event: "Example NLP Meetup", date: "2022-03" },
  ],
  awards: [
    { title: "Best Paper Award", issuer: "Example Conference on Computational Linguistics", date: "2022" },
    { title: "Teaching Excellence Award", issuer: "Example University", date: "2020" },
  ],
  skills: [],
  skillGroups: [
    { category: "Programming", items: ["Python", "PyTorch", "R", "Bash"] },
    { category: "Methods", items: ["Corpus annotation", "Lexicon induction", "MT evaluation"] },
    { category: "Typesetting", items: ["LaTeX", "Markdown"] },
  ],
  languages: [
    { language: "English", proficiency: "Native" },
    { language: "French", proficiency: "Fluent (C1)" },
    { language: "Malay", proficiency: "Intermediate (B1)" },
  ],
  memberships: [{ organization: "Association for Example Computational Linguistics", role: "Member", start_date: "2010" }],
  personalDetails: [
    { label: "Nationality", value: "British" },
    { label: "Date of birth", value: "12 March 1988" },
  ],
  volunteering: [
    {
      organization: "Example Language Archive",
      role: "Volunteer Curator",
      start_date: "2016-01",
      end_date: "present",
      bullets: [{ text: "Digitize and annotate recordings of endangered languages donated by field linguists." }],
    },
  ],
  interests: ["Hill walking", "Choir singing", "Learning languages"],
  references: [
    { name: "Prof. Jamie Example", title: "Professor of Informatics", organization: "Example University", email: "jamie@example.edu" },
    {
      name: "Dr. Morgan Placeholder",
      title: "Reader in Linguistics",
      organization: "Sample Institute of Technology",
      email: "morgan@example.edu",
    },
  ],
};

const ADMIN: Body = {
  title: "Administrative Manager",
  summary:
    "Detail-oriented administrative manager with eight years of experience running office operations, HR support, budgeting and procurement. Proven record of streamlining workflows, cutting costs and keeping senior leaders organised. Calm under pressure, discreet with confidential matters, and quick to learn new systems.",
  skills: [
    "Office administration",
    "Executive calendar management",
    "Budgeting & cost control",
    "Procurement & vendor management",
    "Process improvement",
    "Records management",
    "Event coordination",
    "HR administration & onboarding",
    "Team leadership",
    "Microsoft 365 & Google Workspace",
  ],
  experience: [
    {
      company: "Greenfield Holdings",
      location: "Toronto, Canada",
      role: "Administrative Manager",
      start_date: "2022-10",
      end_date: "present",
      bullets: [
        { text: "Run daily administrative operations for a 120-person office, from scheduling and supplies to facilities." },
        { text: "Introduced a digital document system that cut retrieval time by 45% and simplified audits." },
        { text: "Lead a team of four administrative staff, setting priorities and reviewing performance." },
      ],
    },
    {
      company: "Greenfield Holdings",
      location: "Toronto, Canada",
      role: "HR & Administrative Officer",
      start_date: "2020-09",
      end_date: "2022-09",
      bullets: [
        { text: "Managed personnel files, attendance tracking and payroll coordination for 150 employees." },
        { text: "Designed an onboarding programme that reduced first-year turnover by 12%." },
      ],
    },
    {
      company: "Maple & Pine Consulting",
      location: "Halifax, Canada",
      role: "Office Coordinator",
      start_date: "2018-06",
      end_date: "2020-08",
      bullets: [
        { text: "Coordinated vendor contracts and office supplies, lowering supply costs by 18%." },
        { text: "Organised client events and board meetings of up to 200 guests." },
      ],
    },
  ],
  education: [
    {
      institution: "Example University",
      location: "Halifax, Canada",
      degree: "Bachelor",
      field: "Business Administration",
      gpa: "3.8/4.0",
      start_date: "2014-09",
      end_date: "2018-05",
    },
    {
      institution: "Example Community College",
      location: "Charlottetown, Canada",
      degree: "Diploma",
      field: "Office Administration",
      start_date: "2012-09",
      end_date: "2014-05",
    },
  ],
  certifications: [
    { name: "Certified Administrative Professional (CAP)", issuer: "IAAP", date: "2021-04" },
    { name: "Project Management Essentials", issuer: "Example Institute", date: "2019-11" },
  ],
  languages: [
    { language: "English", proficiency: "Native" },
    { language: "French", proficiency: "Professional working proficiency" },
  ],
  volunteering: [
    {
      organization: "Example Literacy Society",
      role: "Volunteer Coordinator",
      start_date: "2019-01",
      end_date: "present",
      bullets: [{ text: "Schedule 40 volunteer tutors for weekly adult reading classes." }],
    },
  ],
  interests: ["Poetry", "Gardening", "Long walks"],
};

const MARKETING: Body = {
  title: "Marketing Manager",
  summary:
    "Marketing manager with seven years of experience building brands and campaigns across digital and print. Combines sharp storytelling with careful measurement, and has grown audiences, leads and revenue for consumer and B2B companies alike.",
  skills: [],
  skillGroups: [
    { category: "Marketing", items: ["Brand strategy", "Campaign planning", "Content marketing", "SEO"] },
    { category: "Digital", items: ["Paid social", "Email automation", "Google Analytics", "A/B testing"] },
    { category: "Creative", items: ["Copywriting", "Art direction", "Figma", "Adobe Creative Suite"] },
    { category: "Leadership", items: ["Team management", "Budget ownership", "Agency relations"] },
  ],
  experience: [
    {
      company: "Bright Harbor Media",
      location: "New York, USA",
      role: "Marketing Manager",
      start_date: "2021-03",
      end_date: "present",
      bullets: [
        { text: "Lead a team of five and a $1.2M annual budget across brand, content and paid channels." },
        { text: "Relaunched the brand and website, growing organic traffic by 64% in twelve months." },
        { text: "Built an email nurture programme that lifted lead-to-customer conversion from 3% to 7%." },
      ],
    },
    {
      company: "Bright Harbor Media",
      location: "New York, USA",
      role: "Senior Marketing Specialist",
      start_date: "2019-01",
      end_date: "2021-02",
      bullets: [
        { text: "Planned and ran 30+ product campaigns a year with sales and product teams." },
        { text: "Introduced a monthly reporting dashboard adopted by the leadership team." },
      ],
    },
    {
      company: "Example Publishing House",
      location: "Boston, USA",
      role: "Marketing Coordinator",
      start_date: "2017-06",
      end_date: "2018-12",
      bullets: [
        { text: "Coordinated book launches and author tours for 25 titles, two of them bestsellers." },
        { text: "Grew the publisher's newsletter from 8,000 to 31,000 subscribers." },
      ],
    },
  ],
  projects: [
    {
      name: "Stories Worth Sharing",
      subtitle: "Brand campaign",
      bullets: [{ text: "Customer-story video series that reached 2.4M views and won a regional marketing award." }],
    },
  ],
  education: [
    {
      institution: "Example University",
      location: "Boston, USA",
      degree: "B.A.",
      field: "Communications and English Literature",
      start_date: "2013-09",
      end_date: "2017-05",
    },
  ],
  certifications: [
    { name: "Google Analytics Certification", issuer: "Google", date: "2023-01" },
    { name: "Content Marketing Certification", issuer: "Example Academy", date: "2020-06" },
  ],
  awards: [{ title: "Campaign of the Year", issuer: "Example Marketing Association", date: "2022" }],
  languages: [
    { language: "English", proficiency: "Native" },
    { language: "French", proficiency: "Intermediate (B1)" },
  ],
  volunteering: [
    {
      organization: "Example Arts Council",
      role: "Communications Volunteer",
      start_date: "2018-01",
      end_date: "present",
      bullets: [{ text: "Write the newsletter and social posts for community theatre productions." }],
    },
  ],
  interests: ["Writing short fiction", "Theatre", "Photography"],
};

const SALES: Body = {
  title: "Sales Representative",
  summary:
    "Sales representative who builds lasting customer relationships from first call to renewal. Consistently above target, with a knack for finding new markets and turning them into steady revenue.",
  skills: [
    "Sales strategy",
    "Negotiation",
    "Prospecting & lead generation",
    "Account management",
    "Presentation skills",
    "CRM (Salesforce, HubSpot)",
    "Market research",
    "Team collaboration",
  ],
  experience: [
    {
      company: "Sherwood Supply Co.",
      location: "Nottingham, UK",
      role: "Sales Representative",
      start_date: "2022-01",
      end_date: "present",
      bullets: [
        { text: "Grew territory revenue by 25% in the first year by opening 40 new retail accounts." },
        { text: "Manage a portfolio of 50+ clients with a 95% renewal rate." },
        { text: "Run market research with marketing to find and prioritise new regions." },
      ],
    },
    {
      company: "Example Wholesale",
      location: "Leicester, UK",
      role: "Field Sales Agent",
      start_date: "2020-01",
      end_date: "2021-12",
      bullets: [
        { text: "Prospected and qualified leads through cold calling, email campaigns and trade fairs." },
        { text: "Increased average order value by 20% with targeted upselling and bundles." },
        { text: "Kept product knowledge sharp to give customers accurate, trusted advice." },
      ],
    },
    {
      company: "Example Wholesale",
      location: "Leicester, UK",
      role: "Inside Sales Assistant",
      start_date: "2018-06",
      end_date: "2019-12",
      bullets: [
        { text: "Handled 60+ inbound enquiries a day and booked meetings for the field team." },
        { text: "Resolved customer issues quickly, earning a 4.8/5 satisfaction score." },
      ],
    },
  ],
  education: [
    {
      institution: "Example University",
      location: "Nottingham, UK",
      degree: "B.A.",
      field: "Business Management",
      start_date: "2015-09",
      end_date: "2018-06",
    },
  ],
  certifications: [{ name: "Certified Sales Professional", issuer: "Example Sales Institute", date: "2021-05" }],
  languages: [
    { language: "English", proficiency: "Native" },
    { language: "German", proficiency: "Basic" },
  ],
  interests: ["Archery", "Hiking", "Community fundraising"],
};

const STUDENT: Body = {
  title: "Business Administration Student",
  summary:
    "Business administration student who is responsible, organised and quick to learn. Looking for a first role where I can put my customer service experience and spreadsheet skills to work.",
  skills: ["Microsoft Office", "Spreadsheets", "Customer service", "Public speaking", "Teamwork"],
  experience: [
    {
      company: "Riverside General Store",
      location: "Hannibal, USA",
      role: "Customer Service Assistant (part-time)",
      start_date: "2023-06",
      end_date: "present",
      bullets: [
        { text: "Serve 80+ customers a shift at the till and on the shop floor." },
        { text: "Keep stock counts up to date in a shared spreadsheet." },
      ],
    },
  ],
  education: [
    {
      institution: "Example State University",
      location: "Columbia, USA",
      degree: "Bachelor",
      field: "Business Administration",
      start_date: "2023-09",
      end_date: "present",
      honors: "Dean's List, 2024",
    },
    {
      institution: "Riverside High School",
      location: "Hannibal, USA",
      degree: "High School Diploma",
      start_date: "2019-09",
      end_date: "2023-06",
    },
  ],
  activities: [
    {
      title: "Member",
      organization: "University Debate Society",
      start_date: "2023-09",
      end_date: "present",
      bullets: [{ text: "Reached the regional semi-finals in my first year." }],
    },
  ],
  volunteering: [
    {
      organization: "Riverside Community Association",
      role: "Volunteer",
      start_date: "2021-04",
      end_date: "present",
      bullets: [{ text: "Organised a neighbourhood fence-painting day that brought out 30 volunteers." }],
    },
  ],
  languages: [
    { language: "English", proficiency: "Native" },
    { language: "Spanish", proficiency: "Intermediate (B1)" },
  ],
  courses: [{ name: "Introduction to Accounting", institution: "Example Online Academy", date: "2024-02" }],
  interests: ["Fishing", "River rafting", "Storytelling"],
};

const ACCOUNTANT: Body = {
  title: "Certified Public Accountant",
  summary:
    "Certified public accountant with twelve years of experience in audit, tax and financial reporting. Exacting with numbers, careful with every penny, and known for turning month-end close into a calm, predictable routine.",
  skills: [],
  skillGroups: [
    { category: "Accounting", items: ["Financial reporting (IFRS)", "Audit", "Tax compliance", "Month-end close"] },
    { category: "Analysis", items: ["Budgeting & forecasting", "Cost control", "Variance analysis"] },
    { category: "Tools", items: ["Xero", "SAP", "Excel (advanced)", "Power BI"] },
  ],
  experience: [
    {
      company: "Marley & Partners",
      location: "London, UK",
      role: "Senior Accountant",
      start_date: "2016-02",
      end_date: "present",
      bullets: [
        { text: "Own the month-end close for three entities, cutting close time from ten days to four." },
        { text: "Lead the annual external audit, with no material findings in seven consecutive years." },
        { text: "Rebuilt the cost-control process, saving the firm £180,000 a year." },
      ],
    },
    {
      company: "Fezziwig Trading Co.",
      location: "London, UK",
      role: "Accountant",
      start_date: "2012-09",
      end_date: "2016-01",
      bullets: [
        { text: "Prepared VAT returns and statutory accounts for a growing import business." },
        { text: "Introduced cloud bookkeeping, replacing paper ledgers across two offices." },
      ],
    },
  ],
  education: [
    {
      institution: "Example University",
      location: "London, UK",
      degree: "B.Sc.",
      field: "Accounting and Finance",
      start_date: "2009-09",
      end_date: "2012-06",
      honors: "First-class honours",
    },
  ],
  certifications: [
    { name: "Certified Public Accountant (CPA)", issuer: "Example Board of Accountancy", date: "2015-06" },
    { name: "ACCA Qualification", issuer: "ACCA", date: "2014-03" },
  ],
  languages: [
    { language: "English", proficiency: "Native" },
    { language: "German", proficiency: "Professional working proficiency" },
  ],
  volunteering: [
    {
      organization: "Example Children's Charity",
      role: "Honorary Treasurer",
      start_date: "2019-12",
      end_date: "present",
      bullets: [{ text: "Keep the books and file annual returns for a charity serving 2,000 families." }],
    },
  ],
  interests: ["Choral music", "Christmas markets", "Charity work"],
};

// The home page's "after" resume, as content — shown on the template made from it.
const SPARK: Body = {
  title: "Senior Software Engineer",
  summary:
    "Full-stack engineer with 6 years building payment and retail platforms used by 400K+ people. Strong in React Native, Node.js and Java; known for shipping fast with high test coverage and for growing junior engineers.",
  skills: [],
  skillGroups: [
    { category: "Languages", items: ["TypeScript", "Java", "Kotlin", "SQL"] },
    { category: "Frameworks", items: ["React Native", "Node.js", "Spring", "Next.js"] },
    { category: "Infra", items: ["Docker", "AWS", "PostgreSQL", "Redis"] },
  ],
  experience: [
    {
      company: "Abay Fintech",
      location: "Addis Ababa",
      role: "Senior Software Engineer",
      start_date: "2021-01",
      end_date: "present",
      bullets: [
        { text: "Led a 5-engineer squad rebuilding the mobile wallet in React Native, lifting monthly active users from 180K to 420K in 14 months." },
        { text: "Cut payment failure rate 37% by redesigning retry and idempotency logic across 6 Node.js microservices." },
        { text: "Introduced CI/CD with GitHub Actions and Docker, reducing release time from 2 days to 25 minutes." },
        { text: "Mentored 4 junior engineers; two promoted to mid-level within a year." },
      ],
    },
    {
      company: "Entoto Systems",
      location: "Addis Ababa",
      role: "Software Engineer",
      start_date: "2019-01",
      end_date: "2021-01",
      bullets: [
        { text: "Built a Java/Spring inventory platform used by 120+ retail branches, replacing paper logs and saving 30 staff-hours a week." },
        { text: "Raised automated test coverage from 18% to 81%, halving production incidents quarter over quarter." },
        { text: "Wrote the team's API documentation standard, adopted across 3 product lines." },
      ],
    },
    {
      company: "Lalibela Digital",
      location: "Addis Ababa",
      role: "Software Engineering Intern",
      start_date: "2018-06",
      end_date: "2018-09",
      bullets: [{ text: "Shipped a booking dashboard in React used by 40 tour operators; cut manual scheduling errors by half." }],
    },
  ],
  projects: [
    {
      name: "Meskel Pay SDK",
      subtitle: "Open source",
      description: "TypeScript SDK for local mobile-money APIs; 1.2K GitHub stars and used by 30+ startups.",
    },
    {
      name: "Merkato Price Tracker",
      subtitle: "Side project",
      description: "Next.js app tracking 2,000 market prices daily; featured in a national tech newsletter.",
    },
  ],
  education: [
    {
      institution: "Addis Ababa University",
      degree: "B.Sc.",
      field: "Computer Science",
      end_date: "2019-07",
      honors: "Graduated with distinction",
    },
  ],
  certifications: [
    { name: "AWS Certified Developer – Associate", issuer: "Amazon Web Services" },
    { name: "Google Associate Android Developer", issuer: "Google" },
  ],
  awards: [{ title: "Engineer of the Year", issuer: "Abay Fintech", date: "2023" }],
  volunteering: [
    {
      organization: "Addis Youth Coding Club",
      role: "Coding mentor",
      bullets: [{ text: "Teach 25 students a year to build their first web apps." }],
    },
  ],
  languages: [
    { language: "Amharic", proficiency: "Native" },
    { language: "English", proficiency: "Fluent" },
  ],
};

// ---------------------------------------------------------------------------
// Characters — one per template
// ---------------------------------------------------------------------------

const ref = (name: string, title: string, organization: string, email: string, phone?: string) => ({
  name,
  title,
  organization,
  email,
  ...(phone ? { phone } : {}),
});

const SAMPLES: Record<string, SampleCv> = {
  classic: sample(
    {
      name: "Sherlock Holmes",
      email: "sherlock@example.com",
      phone: "+44 20 7946 0221",
      location: "London, UK",
      links: [
        { label: "Website", url: "https://example.com/sherlock" },
        { label: "LinkedIn", url: "https://linkedin.com/in/example" },
      ],
      fit: {
        add: {
          experience: [
            {
              company: "Example University",
              location: "Chicago, IL",
              role: "Research Assistant, Statistics Department",
              start_date: "2017-09",
              end_date: "2019-05",
              bullets: [
                { text: "Cleaned and analysed survey data for three faculty studies; co-authored one published paper." },
                { text: "Taught weekly R lab sessions for 60 undergraduate students." },
                { text: "Built a reproducible analysis template in R Markdown that the lab still uses." },
              ],
            },
          ],
          projects: [
            {
              name: "Open Transit Dashboard",
              subtitle: "Volunteer project",
              tech: ["SQL", "Tableau"],
              bullets: [{ text: "Public dashboard of bus punctuality across 90 routes, used by a city council transport committee." }],
            },
          ],
        },
        moreBullets: [
          ["Ran pricing A/B tests across 12 categories, lifting margin 3 points without hurting conversion."],
          ["Built the team's first data-quality checks in dbt, catching 30+ broken feeds before they reached reports."],
        ],
      },
    },
    ANALYST
  ),
  minimal: sample(
    {
      name: "Captain Nemo",
      email: "nemo@example.com",
      phone: "+33 1 55 01 00 20",
      location: "Remote",
      links: [
        { label: "GitHub", url: "https://github.com/example" },
        { label: "LinkedIn", url: "https://linkedin.com/in/example" },
      ],
      fit: {
        moreBullets: [
          [],
          ["Wrote the team's on-call runbook, cutting mean time to recovery from 45 to 15 minutes."],
          ["Added caching in front of the reporting API, cutting p95 response time from 1.2s to 300ms."],
        ],
      },
    },
    ENGINEER
  ),
  focus: sample(
    {
      name: "Phileas Fogg",
      email: "phileas@example.com",
      phone: "+44 20 7946 0872",
      location: "London, UK",
      title: "Senior Software Engineer",
      links: [
        { label: "GitHub", url: "https://github.com/example" },
        { label: "LinkedIn", url: "https://linkedin.com/in/example" },
      ],
      fit: { bullets: [3] },
    },
    ENGINEER
  ),
  stack: sample(
    {
      name: "Dorothy Gale",
      email: "dorothy@example.com",
      phone: "+1 555 010 1939",
      location: "Kansas City, USA",
      links: [
        { label: "Website", url: "https://example.com/dorothy" },
        { label: "LinkedIn", url: "https://linkedin.com/in/example" },
        { label: "GitHub", url: "https://github.com/example" },
      ],
    },
    ENGINEER
  ),
  prose: sample(
    {
      name: "Elizabeth Bennet", email: "elizabeth@example.com", phone: "+44 1462 000 813", location: "Hertfordshire, UK",
      fit: { keep: { projects: 0, volunteering: 0, awards: 0 } },
    },
    MARKETING
  ),
  formal: sample(
    {
      name: "Jane Eyre",
      email: "jane.eyre@example.com",
      phone: "+44 1535 000 847",
      location: "Yorkshire, UK",
      overrides: {
        personalDetails: [
          { label: "Nationality", value: "British" },
          { label: "Driving licence", value: "Full, clean" },
        ],
      },
      fit: { keep: { projects: 0 } },
    },
    ANALYST
  ),
  scholar: sample(
    {
      name: "Victor Frankenstein",
      email: "victor@example.edu",
      phone: "+41 22 000 1818",
      location: "Geneva, Switzerland",
      links: [{ label: "Website", url: "https://example.edu/frankenstein" }],
      fit: { keep: { publications: 2, presentations: 1, teaching: 1, volunteering: 0, awards: 1, experience: 2, skillGroups: 1, languages: 2, interests: 0, research: 0 } },
    },
    ACADEMIC
  ),
  research: sample(
    {
      name: "Mina Harker", email: "mina@example.edu", phone: "+44 1947 000 897", location: "Whitby, UK",
      fit: { keep: { publications: 2, presentations: 1, awards: 1, experience: 2, skillGroups: 2, interests: 0 } },
    },
    ACADEMIC
  ),
  curve: sample(
    {
      name: "John Watson",
      email: "watson@example.edu",
      phone: "+44 20 7946 0887",
      location: "London, UK",
      overrides: {
        references: [
          ref("Sherlock Holmes", "Consulting Detective", "221B Baker Street", "sherlock@example.com"),
          ref("G. Lestrade", "Inspector", "Scotland Yard", "lestrade@example.com"),
        ],
      },
      fit: { keep: { publications: 1, presentations: 0, teaching: 0, awards: 1, memberships: 0, volunteering: 0, interests: 0, experience: 2, research: 0, skillGroups: 1, languages: 1, education: 2, references: 1 } },
    },
    ACADEMIC
  ),
  accent: sample(
    {
      name: "Anna Karenina",
      email: "anna@example.com",
      phone: "+7 495 000 1877",
      location: "Saint Petersburg, Russia",
      links: [
        { label: "Website", url: "https://example.com/anna" },
        { label: "LinkedIn", url: "https://linkedin.com/in/example" },
      ],
      fit: {
        moreBullets: [
          ["Ran pricing A/B tests across 12 categories, lifting margin 3 points without hurting conversion."],
          ["Built the team's first data-quality checks in dbt, catching 30+ broken feeds before they reached reports."],
        ],
      },
    },
    ANALYST
  ),
  sidebar: sample(
    {
      name: "Robin Hood",
      email: "robin@example.com",
      phone: "+44 115 000 1377",
      location: "Nottingham, UK",
      overrides: {
        personalDetails: [
          { label: "Nationality", value: "English" },
          { label: "Driving licence", value: "Full" },
        ],
      },
      fit: {
        keep: { skills: 4, interests: 0 },
        moreBullets: [
          [],
          ["Represented the company at 6 regional trade fairs, generating 200+ qualified leads."],
          ["Kept the CRM clean and current, so handovers to the field team never lost a lead."],
        ],
        add: {
          projects: [
            {
              name: "New Territory Launch",
              subtitle: "East Midlands, 2023",
              bullets: [{ text: "Planned and ran the launch into 3 new counties, signing 22 accounts in the first quarter." }],
            },
          ],
          certifications: [{ name: "Negotiation Skills Certificate", issuer: "Example Business School", date: "2020-03" }],
        },
      },
    },
    SALES
  ),
  bubble: sample(
    {
      name: "Huckleberry Finn",
      email: "huck@example.com",
      phone: "+1 555 010 1884",
      location: "Hannibal, USA",
      links: [
        { label: "GitHub", url: "https://github.com/example" },
        { label: "LinkedIn", url: "https://linkedin.com/in/example" },
      ],
      fit: { keep: { projects: 0, certifications: 1, interests: 1, skillGroups: 2 }, bullets: [3, 2, 1] },
    },
    ENGINEER
  ),
  slate: sample(
    {
      name: "Emma Woodhouse",
      email: "emma@example.com",
      phone: "+44 1372 000 815",
      location: "Surrey, UK",
      overrides: {
        personalDetails: [
          { label: "Nationality", value: "British" },
          { label: "Driving licence", value: "Full, clean" },
        ],
      },
      fit: {
        keep: { skillGroups: 2 },
        add: {
          experience: [
            {
              company: "Example University",
              location: "Chicago, IL",
              role: "Research Assistant, Statistics Department",
              start_date: "2017-09",
              end_date: "2019-05",
              bullets: [
                { text: "Cleaned and analysed survey data for three faculty studies; co-authored one published paper." },
                { text: "Taught weekly R lab sessions for 60 undergraduate students." },
              ],
            },
          ],
        },
        moreBullets: [
          ["Ran pricing A/B tests across 12 categories, lifting margin 3 points without hurting conversion."],
          ["Built the team's first data-quality checks in dbt, catching 30+ broken feeds before they reached reports."],
        ],
      },
    },
    ANALYST
  ),
  halo: sample(
    { name: "Peter Pan", email: "peter@example.com", phone: "+44 20 7946 0904", location: "London, UK" },
    MARKETING
  ),
  banner: sample(
    {
      name: "Jay Gatsby",
      email: "gatsby@example.com",
      phone: "+1 555 010 1925",
      location: "West Egg, New York",
      links: [{ label: "Website", url: "https://example.com/gatsby" }],
      overrides: {
        references: [
          ref("Nick Carraway", "Bond Salesman", "Probity Trust", "nick@example.com", "+1 555 010 1922"),
          ref("Jordan Baker", "Professional Golfer", "Example Golf Club", "jordan.baker@example.com"),
        ],
      },
      fit: { keep: { projects: 0, volunteering: 0, awards: 0 } },
    },
    MARKETING
  ),
  capsule: sample(
    {
      name: "Jo March",
      email: "jo@example.com",
      phone: "+1 555 010 1868",
      location: "Concord, USA",
      links: [{ label: "Website", url: "https://example.com/jo" }],
      overrides: {
        references: [
          ref("Theodore Laurence", "Director", "Laurence & Co.", "laurie@example.com", "+1 555 010 1869"),
          ref("Friedrich Bhaer", "Professor", "Plumfield School", "bhaer@example.com", "+1 555 010 1870"),
        ],
      },
      fit: { keep: { projects: 0, volunteering: 0 } },
    },
    MARKETING
  ),
  campus: sample(
    {
      name: "Tom Sawyer", email: "tom@example.com", phone: "+1 555 010 1876", location: "Hannibal, USA", links: [],
      fit: {
        moreBullets: [
          ["Train new part-time staff on the till and the opening routine.", "Set up the store's first social media page, growing it to 600 local followers."],
        ],
      },
    },
    STUDENT
  ),
  linen: sample(
    {
      name: "Ebenezer Scrooge",
      email: "scrooge@example.com",
      phone: "+44 20 7946 1843",
      location: "London, UK",
      links: [],
      overrides: {
        references: [
          ref("Mr. Fezziwig", "Owner", "Fezziwig Trading Co.", "fezziwig@example.com", "+44 20 7946 1800"),
          ref("Bob Cratchit", "Clerk", "Marley & Partners", "bob@example.com", "+44 20 7946 1801"),
        ],
      },
      fit: { keep: { volunteering: 0, certifications: 1, interests: 0 }, bullets: [2, 1] },
    },
    ACCOUNTANT
  ),
  crest: sample(
    {
      name: "Anne Shirley",
      email: "anne@example.com",
      phone: "+1 555 010 1908",
      location: "Charlottetown, Canada",
      links: [],
      overrides: {
        references: [
          ref("Marilla Cuthbert", "Owner", "Green Gables Farm", "marilla@example.com", "+1 555 010 1909"),
          ref("Gilbert Blythe", "Physician", "Example Hospital", "gilbert@example.com", "+1 555 010 1910"),
        ],
      },
      fit: {
        moreBullets: [
          ["Introduced a shared digital filing system, cutting document search time by half."],
          ["Organised 30+ internal events a year, from team offsites to board meetings."],
        ],
      },
    },
    ADMIN
  ),
  clarity: sample(
    {
      name: "Catherine Earnshaw",
      email: "catherine@example.com",
      phone: "+44 1535 000 184",
      location: "Yorkshire, UK",
      links: [],
      overrides: {
        references: [
          ref("Edgar Linton", "Magistrate", "Thrushcross Grange", "edgar@example.com"),
          ref("Ellen Dean", "Housekeeper", "Wuthering Heights", "nelly@example.com"),
        ],
      },
      fit: { keep: { volunteering: 0 } },
    },
    ADMIN
  ),
  midnight: sample(
    {
      name: "Edmond Dantès",
      email: "edmond@example.com",
      phone: "+33 4 91 00 18 44",
      location: "Marseille, France",
      title: "Software Engineer",
      links: [{ label: "Website", url: "https://example.com/edmond" }],
      overrides: {
        references: [
          ref("Pierre Morrel", "Shipowner", "Morrel & Son", "morrel@example.com"),
          ref("Abbé Faria", "Scholar", "Château d'If Library", "faria@example.com"),
        ],
      },
    },
    ENGINEER
  ),
  timeline: sample(
    {
      name: "Oliver Twist",
      email: "oliver@example.com",
      phone: "+44 20 7946 1838",
      location: "London, UK",
      links: [{ label: "Website", url: "https://example.com/oliver" }],
      overrides: {
        references: [
          ref("Mr. Brownlow", "Director", "Brownlow & Co.", "brownlow@example.com", "+44 20 7946 1839"),
          ref("Rose Maylie", "Manager", "Example Charity Trust", "rose@example.com", "+44 20 7946 1840"),
        ],
      },
      fit: {
        moreBullets: [
          ["Trained and mentored 3 new representatives, all reaching target within their first quarter."],
          ["Represented the company at 6 regional trade fairs, generating 200+ qualified leads."],
          ["Kept the CRM clean and current, so handovers to the field team never lost a lead."],
        ],
        add: {
          awards: [{ title: "Top Sales Representative", issuer: "Sherwood Supply Co.", date: "2023" }],
          certifications: [{ name: "Negotiation Skills Certificate", issuer: "Example Business School", date: "2020-03" }],
        },
      },
    },
    SALES
  ),
  spark: sample(
    {
      name: "Robinson Crusoe",
      email: "robinson@example.com",
      phone: "+251 911 000 719",
      location: "Addis Ababa, Ethiopia",
      links: [
        { label: "LinkedIn", url: "https://linkedin.com/in/example" },
        { label: "GitHub", url: "https://github.com/example" },
      ],
      fit: {
        moreBullets: [
          [],
          ["Paired with product on discovery for a loyalty feature now used by 60K shoppers."],
          [
            "Wrote end-to-end tests for the booking flow that caught 15 regressions before release.",
            "Presented the dashboard to the founders, who rolled it out to every partner operator.",
          ],
        ],
        add: {
          references: [
            ref("Friday", "Engineering Manager", "Abay Fintech", "friday@example.com", "+251 911 000 720"),
            ref("Captain Rodrigues", "Chief Technology Officer", "Entoto Systems", "captain@example.com"),
          ],
          interests: ["Open-source", "Long-distance running", "Ethiopian jazz"],
        },
      },
    },
    SPARK
  ),
};

/** The one sample CV a template's thumbnail shows. */
export function sampleCvFor(templateId: string): SampleCv {
  return SAMPLES[templateId] ?? SAMPLES.classic;
}

/** Template ids that have a sample (every registry id should; checked in the unit tests). */
export const SAMPLE_TEMPLATE_IDS = Object.keys(SAMPLES);
