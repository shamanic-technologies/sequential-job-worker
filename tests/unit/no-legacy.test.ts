import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * CRITICAL: These tests ensure no legacy patterns remain in worker.
 *
 * Context: brandId is now set by api-service at campaign creation time.
 * Workers should NOT call updateCampaign to set brandId.
 * Old worker files (brand-upsert, brand-profile, lead-search) should not exist.
 */
describe('No Legacy Patterns - Worker', () => {
  const srcDir = path.join(__dirname, '../../src');
  const workersDir = path.join(srcDir, 'workers');

  function getAllTsFiles(dir: string): string[] {
    const files: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...getAllTsFiles(fullPath));
      } else if (entry.name.endsWith('.ts')) {
        files.push(fullPath);
      }
    }
    return files;
  }

  it('should NOT have deprecated brandId comments', () => {
    const files = getAllTsFiles(srcDir);
    const violations: { file: string; line: number; code: string }[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');

      lines.forEach((line, index) => {
        const lowerLine = line.toLowerCase();
        if (lowerLine.includes('deprecated') && lowerLine.includes('brandid')) {
          violations.push({
            file: path.relative(srcDir, file),
            line: index + 1,
            code: line.trim().substring(0, 80)
          });
        }
      });
    }

    expect(
      violations,
      `Files with deprecated brandId comments:\n${violations.map(v => `  ${v.file}:${v.line}\n    ${v.code}`).join('\n')}`
    ).toHaveLength(0);
  });

  it('should NOT have old worker files', () => {
    const workerFiles = fs.readdirSync(workersDir);
    expect(workerFiles).not.toContain('brand-upsert.ts');
    expect(workerFiles).not.toContain('brand-profile.ts');
    expect(workerFiles).not.toContain('lead-search.ts');
  });

  it('should NOT call updateCampaign in get-brand-sales-profile worker', () => {
    const profileFile = path.join(workersDir, 'get-brand-sales-profile.ts');
    const content = fs.readFileSync(profileFile, 'utf-8');

    expect(content).not.toContain('updateCampaign');
  });

  it('should have new pipeline worker files', () => {
    const workerFiles = fs.readdirSync(workersDir);
    expect(workerFiles).toContain('create-run.ts');
    expect(workerFiles).toContain('get-campaign-info.ts');
    expect(workerFiles).toContain('get-brand-sales-profile.ts');
    expect(workerFiles).toContain('get-campaign-leads.ts');
    expect(workerFiles).toContain('email-generate.ts');
    expect(workerFiles).toContain('email-send.ts');
  });
});
