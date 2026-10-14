import { PrismaClient } from '../src/generated/prisma/client.js'

import { getDatabaseUrl } from '../src/database-url.js'

import { PrismaPg } from '@prisma/adapter-pg'

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL_UNPOOLED || getDatabaseUrl(),
})

const prisma = new PrismaClient({ adapter })

// Course metadata only: rerunning this seed preserves availability and sessions.
const COURSES = [
  {
    slug: 'lake-padden',
    name: 'Lake Padden Golf Course',
    platform: 'cps',
    bookingUrl:
      'https://lakepaddenpremier.cps.golf/onlineresweb/search-teetime',
    config: { login: true }, // CPS site with no guest browsing -- scraper needs a saved session
  },
  {
    slug: 'sudden-valley',
    name: 'Sudden Valley Golf Course',
    platform: 'cps',
    bookingUrl: 'https://suddenvalley.cps.golf/onlineresweb/search-teetime',
    config: {},
  },
  {
    slug: 'loomis-trail',
    name: 'Loomis Trail Golf Course',
    platform: 'teesnap',
    bookingUrl: 'https://golfloomis.teesnap.net/',
    config: { courseId: 789 },
  },
  {
    slug: 'north-bellingham',
    name: 'North Bellingham Golf Course',
    platform: 'chronogolf',
    bookingUrl: 'https://www.chronogolf.com/club/north-bellingham-golf-course',
    config: { clubId: 14786, courseId: 16978, affiliationTypeId: 59966 },
  },
  {
    slug: 'raspberry-ridge',
    name: 'Raspberry Ridge Golf Course',
    platform: 'golfrev',
    bookingUrl: 'https://www.golfrev.com/go/tee_times/?htc=371&courseid=3763',
    config: { courseId: 3763, htc: 371 },
  },
  {
    slug: 'shuksan',
    name: 'Shuksan Golf Club',
    platform: 'foreup',
    bookingUrl: 'https://foreupsoftware.com/index.php/booking/22876/#/teetimes',
    config: { courseId: 22876, bookingClass: 51486, scheduleId: 12179 },
  },
]

async function main() {
  console.log('Seeding courses...')

  for (const course of COURSES) {
    await prisma.course.upsert({
      where: { slug: course.slug },
      create: course,
      update: course,
    })
    console.log(`Ready: ${course.name}`)
  }
}

main()
  .catch((e) => {
    console.error('Error seeding courses:', e)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
