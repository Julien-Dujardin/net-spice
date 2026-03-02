import { Component, inject, signal, OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FileIoService } from '../editor/services/file-io.service';

export interface ExampleEntry {
  name: string;          // folder name = display name
  image: string;         // path to cover image
  project: string;       // path to .nsp file
}

/** Static manifest — add a line for every folder under assets/examples/ */
const EXAMPLE_FOLDERS = [
  'DAC_r2r',
  'RC_filter',
  'Minimum_detector',
  'Sigmoid'
];

@Component({
  selector: 'app-home',
  imports: [RouterLink],
  templateUrl: './home.html',
  styleUrl: './home.css',
})
export class Home implements OnInit {
  private router = inject(Router);
  private fileIo = inject(FileIoService);

  examples = signal<ExampleEntry[]>([]);

  ngOnInit(): void {
    this.examples.set(
      EXAMPLE_FOLDERS.map(folder => ({
        name: folder.replace(/_/g, ' '),
        image: `assets/examples/${folder}/image.png`,
        project: `assets/examples/${folder}/circuit.nsp`,
      }))
    );
  }

  async openExample(ex: ExampleEntry): Promise<void> {
    try {
      await this.fileIo.loadFromUrl(ex.project);
      this.router.navigate(['/editor']);
    } catch (err) {
      console.error('Failed to load example:', err);
    }
  }
}

