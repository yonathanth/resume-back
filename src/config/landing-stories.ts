/**
 * The "after" resumes on the landing page's Real results section: fixed,
 * fictional people, rendered with real templates through
 * GET /api/v1/templates/:id/sample?story=<key>. Only these fixed contents can
 * be rendered that way — the public endpoint never takes content from the
 * request. PLACEHOLDERS: replace with real users' stories (with their consent)
 * before launch, in step with resume-front src/lib/social-proof.ts.
 */
export const LANDING_STORIES: Record<string, Record<string, unknown>> = {
  "hana": {
    "personal": {
      "full_name": "Hana Bekele",
      "title": "Clinical Research Coordinator",
      "email": "hana.bekele@email.com",
      "phone": "+251 912 345 678",
      "location": "Addis Ababa, Ethiopia",
      "links": [
        {
          "label": "LinkedIn",
          "url": "https://linkedin.com/in/hanabekele"
        }
      ]
    },
    "summary": "Registered nurse with 7 years in critical care, moving into clinical research. Hands-on with protocol-driven care, informed consent and trial data collection across two hospital studies, with a record of precise documentation and calm work under pressure.",
    "experience": [
      {
        "company": "St. Paul's Hospital",
        "role": "ICU Registered Nurse",
        "start_date": "2018",
        "end_date": "present",
        "bullets": [
          {
            "text": "Coordinated care for 6–8 critical patients per shift in a 24-bed ICU, with a 98% medication-safety audit score."
          },
          {
            "text": "Collected and logged trial data for 2 sepsis studies (180 patients) with zero protocol deviations."
          },
          {
            "text": "Ran informed-consent conversations with families for 60+ study enrolments."
          },
          {
            "text": "Trained 14 new nurses on charting standards, cutting documentation errors by 30%."
          }
        ]
      },
      {
        "company": "Black Lion Hospital",
        "role": "Nursing Intern",
        "start_date": "Jun 2017",
        "end_date": "Dec 2017",
        "bullets": [
          {
            "text": "Rotated through surgical, pediatric and emergency wards; supported 20+ admissions a day."
          },
          {
            "text": "Built a bedside checklist for post-op vitals, adopted by the surgical ward."
          },
          {
            "text": "Shadowed the ward's research nurse on a hypertension study, learning case report form basics."
          }
        ]
      }
    ],
    "education": [
      {
        "institution": "Addis Ababa University",
        "degree": "BSc Nursing",
        "end_date": "2017"
      }
    ],
    "skills": [
      "GCP",
      "Informed consent",
      "Case report forms",
      "REDCap",
      "Critical care",
      "Patient monitoring",
      "Triage",
      "Excel",
      "SPSS",
      "EHR"
    ],
    "skillGroups": [
      {
        "category": "Research",
        "items": [
          "GCP",
          "Informed consent",
          "Case report forms",
          "REDCap"
        ]
      },
      {
        "category": "Clinical",
        "items": [
          "Critical care",
          "Patient monitoring",
          "Triage"
        ]
      },
      {
        "category": "Tools",
        "items": [
          "Excel",
          "SPSS",
          "EHR"
        ]
      }
    ],
    "projects": [
      {
        "name": "Sepsis Bundle Trial",
        "subtitle": "Study site nurse",
        "description": "Screened and enrolled 120 patients; kept case report forms audit-ready for the sponsor."
      },
      {
        "name": "ICU Handover Protocol",
        "subtitle": "Quality project",
        "description": "Standardized shift handovers; missed-task incidents fell by a third in 6 months."
      }
    ],
    "certifications": [
      {
        "name": "ICH-GCP Certificate (NIDA)"
      },
      {
        "name": "Basic & Advanced Life Support"
      }
    ],
    "languages": [
      {
        "language": "Amharic",
        "proficiency": "Native"
      },
      {
        "language": "English",
        "proficiency": "Fluent"
      }
    ],
    "awards": [
      {
        "title": "Nurse of the Year",
        "issuer": "St. Paul's Hospital",
        "date": "2022"
      }
    ],
    "volunteering": [
      {
        "organization": "Ethiopian Red Cross Society",
        "role": "First Aid Trainer",
        "start_date": "2019",
        "end_date": "present",
        "bullets": [
          {
            "text": "Teach monthly first-aid courses to 30+ community volunteers."
          }
        ]
      }
    ],
    "interests": [
      "Public health",
      "Long-distance running",
      "Coffee ceremony"
    ]
  },
  "daniel": {
    "personal": {
      "full_name": "Daniel Okafor",
      "title": "Account Executive",
      "email": "daniel.okafor@email.com",
      "phone": "+234 803 000 1122",
      "location": "Lagos, Nigeria",
      "links": [
        {
          "label": "LinkedIn",
          "url": "https://linkedin.com/in/danielokafor"
        }
      ]
    },
    "summary": "Retail leader with 6 years turning foot traffic into revenue. Ran a 12-person floor team, grew store sales 22% year over year and built a repeat-customer program from scratch. Ready to bring the same targets-first habits to B2B sales. Comfortable with cold outreach, CRM pipelines and closing with procurement teams.",
    "experience": [
      {
        "company": "ShopRite Lekki",
        "role": "Store Supervisor",
        "start_date": "2019",
        "end_date": "2024",
        "bullets": [
          {
            "text": "Grew store revenue 22% YoY (₦1.4B) by coaching a 12-person team on upselling and bundles."
          },
          {
            "text": "Launched a loyalty program that brought back 3,400 repeat customers in its first year."
          },
          {
            "text": "Negotiated in-store promotions with 9 supplier brands, adding ₦60M in co-funded campaigns."
          },
          {
            "text": "Resolved escalations same-day, lifting satisfaction scores from 3.9 to 4.6."
          }
        ]
      },
      {
        "company": "Slot Systems",
        "role": "Sales Associate",
        "start_date": "2017",
        "end_date": "2019",
        "bullets": [
          {
            "text": "Top seller in 7 of 24 months across 15 associates; 118% of annual target in 2018."
          },
          {
            "text": "Opened 40 corporate accounts for bulk phone and laptop orders."
          },
          {
            "text": "Built a weekly sales huddle that lifted average basket size by 12% in six months."
          }
        ]
      },
      {
        "company": "Jumia Nigeria",
        "role": "Customer Service Representative",
        "start_date": "2016",
        "end_date": "2017",
        "bullets": [
          {
            "text": "Handled 70+ customer calls and chats a day with a 92% first-contact resolution rate."
          },
          {
            "text": "Flagged recurring delivery complaints that led to a new courier SLA in Lekki."
          },
          {
            "text": "Ranked top 3 of 25 reps for upsell rate in two consecutive quarters."
          }
        ]
      }
    ],
    "education": [
      {
        "institution": "University of Lagos",
        "degree": "BA Business Administration",
        "end_date": "2017"
      }
    ],
    "skills": [
      "Prospecting",
      "Negotiation",
      "Upselling",
      "Account management",
      "HubSpot CRM",
      "Excel",
      "Google Sheets",
      "Team coaching",
      "Targets & KPIs"
    ],
    "skillGroups": [
      {
        "category": "Sales",
        "items": [
          "Prospecting",
          "Negotiation",
          "Upselling",
          "Account management"
        ]
      },
      {
        "category": "Tools",
        "items": [
          "HubSpot CRM",
          "Excel",
          "Google Sheets"
        ]
      },
      {
        "category": "Leadership",
        "items": [
          "Team coaching",
          "Targets & KPIs"
        ]
      }
    ],
    "projects": [
      {
        "name": "Corporate Gifting Desk",
        "subtitle": "Initiative",
        "description": "Pitched and ran a B2B gifting desk; 25 company clients and ₦95M in Q4 orders."
      },
      {
        "name": "New Hire Sales Playbook",
        "subtitle": "Training",
        "description": "Wrote the floor sales playbook now used to onboard staff in 4 branches."
      },
      {
        "name": "Weekend Pop-Up Sales",
        "subtitle": "Side business",
        "description": "Ran monthly pop-up stalls selling phone accessories; ₦4M in sales over 18 months."
      }
    ],
    "certifications": [
      {
        "name": "HubSpot Inbound Sales"
      },
      {
        "name": "Google Digital Marketing Fundamentals"
      }
    ],
    "languages": [
      {
        "language": "English",
        "proficiency": "Native"
      },
      {
        "language": "Yoruba",
        "proficiency": "Fluent"
      }
    ],
    "awards": [
      {
        "title": "Store Supervisor of the Year",
        "issuer": "ShopRite Nigeria",
        "date": "2023"
      }
    ],
    "volunteering": [
      {
        "organization": "Junior Achievement Nigeria",
        "role": "Volunteer Mentor",
        "start_date": "2021",
        "end_date": "present",
        "bullets": [
          {
            "text": "Coach secondary-school teams through a 12-week student enterprise programme."
          }
        ]
      }
    ],
    "references": [
      {
        "name": "Ngozi Adeyemi",
        "title": "Regional Operations Manager",
        "organization": "ShopRite Nigeria",
        "email": "ngozi.adeyemi@email.com",
        "phone": "+234 803 000 2233"
      },
      {
        "name": "Tunde Bakare",
        "title": "Sales Manager",
        "organization": "Slot Systems",
        "email": "tunde.bakare@email.com"
      }
    ],
    "interests": [
      "Football",
      "Afrobeats",
      "Public speaking"
    ]
  },
  "sara": {
    "personal": {
      "full_name": "Sara Tesfaye",
      "title": "Financial Analyst",
      "email": "sara.tesfaye@email.com",
      "phone": "+251 911 223 344",
      "location": "Addis Ababa, Ethiopia",
      "links": [
        {
          "label": "LinkedIn",
          "url": "https://linkedin.com/in/saratesfaye"
        }
      ]
    },
    "summary": "Accountant with 6 years in manufacturing finance, building the forecasts and reports leadership decides on. Strong in Excel modeling, variance analysis and Power BI, and in turning month-end numbers into plain, actionable recommendations.",
    "experience": [
      {
        "company": "Habesha Breweries",
        "role": "Senior Accountant",
        "start_date": "2020",
        "end_date": "present",
        "bullets": [
          {
            "text": "Cut month-end close from 9 to 5 days by automating 14 reconciliations in Excel."
          },
          {
            "text": "Built a cost model that flagged $210K in packaging overspend, recovered within 2 quarters."
          },
          {
            "text": "Prepared monthly variance reports for the CFO across 3 production sites."
          },
          {
            "text": "Led the move to IFRS reporting with the external auditors; clean audit opinion 3 years running."
          }
        ]
      },
      {
        "company": "Moenco",
        "role": "Junior Accountant",
        "start_date": "2018",
        "end_date": "2020",
        "bullets": [
          {
            "text": "Processed 1,200 vendor invoices a month with a 0.4% error rate."
          },
          {
            "text": "Rebuilt the fixed-asset register, finding 60 untracked assets worth $85K."
          },
          {
            "text": "Reconciled 40+ bank and supplier accounts monthly with zero audit findings."
          }
        ]
      }
    ],
    "education": [
      {
        "institution": "Addis Ababa University",
        "degree": "BA Accounting & Finance",
        "end_date": "2018"
      }
    ],
    "skills": [
      "Financial modeling",
      "Forecasting",
      "Variance analysis",
      "Excel",
      "Power BI",
      "SAP",
      "Peachtree",
      "IFRS",
      "Budgeting",
      "Audit support"
    ],
    "skillGroups": [
      {
        "category": "Analysis",
        "items": [
          "Financial modeling",
          "Forecasting",
          "Variance analysis"
        ]
      },
      {
        "category": "Tools",
        "items": [
          "Excel",
          "Power BI",
          "SAP",
          "Peachtree"
        ]
      },
      {
        "category": "Reporting",
        "items": [
          "IFRS",
          "Budgeting",
          "Audit support"
        ]
      }
    ],
    "projects": [
      {
        "name": "Rolling Forecast Model",
        "subtitle": "Finance project",
        "description": "12-month driver-based forecast in Excel; within 3% of actuals for 4 straight quarters."
      },
      {
        "name": "Margin Dashboard",
        "subtitle": "Power BI",
        "description": "Product-level margin dashboard used in the weekly leadership meeting."
      }
    ],
    "certifications": [
      {
        "name": "ACCA (Part-qualified)"
      },
      {
        "name": "Financial Modeling & Valuation Analyst"
      }
    ],
    "languages": [
      {
        "language": "Amharic",
        "proficiency": "Native"
      },
      {
        "language": "English",
        "proficiency": "Fluent"
      }
    ],
    "awards": [
      {
        "title": "Finance Team Excellence Award",
        "issuer": "Habesha Breweries",
        "date": "2023"
      }
    ],
    "references": [
      {
        "name": "Yonas Alemu",
        "title": "Finance Director",
        "organization": "Habesha Breweries",
        "email": "yonas.alemu@email.com",
        "phone": "+251 911 55 66 77"
      },
      {
        "name": "Meron Haile",
        "title": "Senior Accountant",
        "organization": "Moenco",
        "email": "meron.haile@email.com"
      }
    ],
    "interests": [
      "Personal finance",
      "Chess",
      "Hiking Entoto"
    ]
  },
  "mateo": {
    "personal": {
      "full_name": "Mateo Ruiz",
      "title": "Instructional Designer",
      "email": "mateo.ruiz@email.com",
      "phone": "(951) 555-0142",
      "location": "Riverside, CA",
      "links": [
        {
          "label": "Portfolio",
          "url": "https://mateoruiz.design"
        }
      ]
    },
    "summary": "Science teacher of 8 years who designs learning people actually finish. Built a blended biology course now used district-wide, produced 40+ video lessons, and used assessment data to show what worked instead of guessing.",
    "experience": [
      {
        "company": "Lincoln High School",
        "role": "Science Teacher & Curriculum Lead",
        "start_date": "2016",
        "end_date": "2024",
        "bullets": [
          {
            "text": "Designed a blended biology course adopted by 9 schools and 1,800 students."
          },
          {
            "text": "Raised pass rates from 71% to 88% by redesigning assessments around learning goals."
          },
          {
            "text": "Produced 40+ short video lessons and job aids for remote learning."
          },
          {
            "text": "Led monthly workshops training 25 teachers on the district LMS."
          }
        ]
      },
      {
        "company": "UC Riverside Extension",
        "role": "Summer STEM Program Coordinator",
        "start_date": "2019",
        "end_date": "2023",
        "bullets": [
          {
            "text": "Planned 4-week hands-on labs for 120 students a summer; 94% would recommend."
          },
          {
            "text": "Recruited and trained 10 undergraduate mentors each year."
          }
        ]
      }
    ],
    "education": [
      {
        "institution": "UC Riverside",
        "degree": "M.Ed. Curriculum & Instruction",
        "end_date": "2019"
      },
      {
        "institution": "UC Riverside",
        "degree": "BS Biology",
        "end_date": "2015"
      }
    ],
    "skills": [
      "ADDIE",
      "Storyboarding",
      "Assessment design",
      "Articulate 360",
      "Canvas LMS",
      "Camtasia",
      "Figma",
      "Facilitation",
      "Video lessons"
    ],
    "skillGroups": [
      {
        "category": "Design",
        "items": [
          "ADDIE",
          "Storyboarding",
          "Assessment design"
        ]
      },
      {
        "category": "Tools",
        "items": [
          "Articulate 360",
          "Canvas LMS",
          "Camtasia",
          "Figma"
        ]
      },
      {
        "category": "Delivery",
        "items": [
          "Facilitation",
          "Video lessons"
        ]
      }
    ],
    "projects": [
      {
        "name": "Lab Safety eLearning",
        "subtitle": "Articulate Rise",
        "description": "20-minute module that replaced a 2-hour lecture; completion rose to 97%."
      }
    ],
    "certifications": [
      {
        "name": "ATD Instructional Design Certificate"
      }
    ],
    "languages": [
      {
        "language": "English",
        "proficiency": "Native"
      },
      {
        "language": "Spanish",
        "proficiency": "Native"
      }
    ]
  }
};
