import type { Branch, LabId } from './types';

export interface Facility {
  id: LabId;
  name: string;
  equipment: string[];
  /** Where the skills from this lab are used in industry. */
  industry: string;
}

export const FACILITIES: Facility[] = [
  {
    id: 'workshop', name: 'Workshop',
    equipment: ['Centre lathes', 'Milling machines', 'Pillar-type drilling machine', 'Shaper machine', 'Arc welding set-up', 'Spot welding set-up', 'GMAW (MIG) set-up', 'Wood-turning lathe', 'Open-hearth furnace'],
    industry: 'Manufacturing and fabrication work.',
  },
  {
    id: 'engg-drawing', name: 'Engineering Drawing & Computer Graphics',
    equipment: ['Drawing boards', 'Drawing instruments', 'CAD workstations'],
    industry: 'Basics of engineering drawing and computer graphics for every branch.',
  },
  {
    id: 'machine-drawing', name: 'Machine Drawing I',
    equipment: ['Drawing boards', 'Drawing instruments'],
    industry: 'Drawings of components and their assemblies in industry.',
  },
  {
    id: 'applied-mechanics', name: 'Applied Mechanics Lab',
    equipment: ['Universal testing machine (UTM)', 'Torsion testing machine', 'Brinell hardness tester', 'Digital spring testing machine (200 kg capacity)', 'Bend and re-bend test set-up for flat specimens', 'Strain gauges', 'Brinell microscope'],
    industry: 'Design of structures and load calculation.',
  },
  {
    id: 'fluid-mechanics', name: 'Fluid Mechanics & Hydraulic Machines Lab',
    equipment: ['Venturimeter', 'Notch and weir set-up', 'Pitot tube', 'Bernoulli theorem apparatus', "Reynolds' experiment apparatus", 'Pelton turbine', 'Reciprocating pump', 'Centrifugal pump', "Darcy friction-factor apparatus"],
    industry: 'Design of rotodynamic machines, hydraulic dams and hydraulic brake systems; aviation and power industry.',
  },
  {
    id: 'material-testing', name: 'Material Testing Lab',
    equipment: ['Impact testing machine', 'Cupping (Erichsen) testing machine', 'Fatigue testing machine', 'Metallurgical microscope', 'Muffle furnace', 'Dye-penetrant test set-up', 'Magnetic-particle (Magnaflux) test set-up', 'Eddy-current test set-up'],
    industry: 'Testing materials for structural use and finding cracks in structures and fabrications at macro and micro level.',
  },
  {
    id: 'thermo-heat-transfer', name: 'Applied Thermodynamics & Heat Transfer Lab',
    equipment: ['Shell-and-tube heat exchanger', 'Single-acting reciprocating air compressor', 'Combined separating and throttling calorimeter', 'Emissivity test apparatus', 'Pin-fin apparatus', 'Thermal conductivity apparatus (metal plate and insulating powder)'],
    industry: 'Thermal power plants and the automobile industry.',
  },
  {
    id: 'design-practice', name: 'Design Practice',
    equipment: ['Drawing boards and instruments', 'CAD laboratory'],
    industry: 'Drawings of components and their assemblies in industry.',
  },
  {
    id: 'metrology', name: 'Metrology & Measurement Lab',
    equipment: ['Vernier caliper', 'Digital vernier caliper', 'Vernier height and depth gauges', 'Digital micrometer', 'Thread gauge', 'Radius gauge', 'Feeler gauge', 'Vernier bevel protractor', 'Sine bar and slip gauges', 'Angle gauges', 'Dial gauge', 'Strain gauge', 'Profile projector'],
    industry: 'Inspection of components and machine parts at macro and micro level.',
  },
  {
    id: 'machining', name: 'Machining & Machine Tools Lab',
    equipment: ['Lathe', 'Milling machine', 'Drilling machine', 'Shaping machine', 'Lathe tool dynamometer', 'Thermocouple (8-channel)', "Tool maker's microscope"],
    industry: 'Manufacturing and fabrication work.',
  },
  {
    id: 'ic-engine', name: 'IC Engine Lab',
    equipment: ['4-stroke diesel engine with rope-brake dynamometer and electrical load box', 'Multi-cylinder petrol engine with rope-brake dynamometer', 'Single-cylinder 4-stroke diesel engine with eddy-current dynamometer', 'Cut-section models of 2- and 4-stroke petrol and diesel engines', 'Bomb calorimeter', 'Orsat apparatus'],
    industry: 'Power plants and the automobile industry.',
  },
  {
    id: 'dynamics-of-machines', name: 'Dynamics of Machines Lab',
    equipment: ['Governors (Watt, Porter, Proell, Hartnell)', 'Gyroscope', 'Cam mechanism', 'Vibration testing machine', 'Reciprocating machine'],
    industry: 'Balancing and vibration analysis of rotating and reciprocating components.',
  },
  {
    id: 'ac-refrigeration', name: 'Air Conditioning & Refrigeration Lab',
    equipment: ['Cut section of a window room air conditioner', 'Thermoelectric refrigeration apparatus', 'Vapour-compression refrigeration apparatus', 'Air-conditioner test rig'],
    industry: 'Comfort air-conditioning, food processing and preservation, chemical and process industry.',
  },
  {
    id: 'design-practice-2', name: 'Design Practice II',
    equipment: ['AutoCAD', 'Creo Parametric', 'Ansys Fluent'],
    industry: 'Modelling components and assembling them into full-scale models with modern software.',
  },
  {
    id: 'adv-manufacturing', name: 'Advanced Manufacturing Technology Lab',
    equipment: ['CNC lathe', 'CNC milling machine', 'Six-axis educational robot'],
    industry: 'Precision instruments and machine parts, food processing, reverse engineering, rapid prototyping, medical appliances.',
  },
  {
    id: 'thermal-power', name: 'Thermal Power Lab',
    equipment: ['Cut models of fire-tube boilers (Cochran, Lancashire, locomotive)', 'Cut model of a water-tube boiler (Babcock & Wilcox)', 'Cut-section models of 2- and 4-stroke petrol and diesel engines', 'Abel flash-point and fire-point apparatus', 'Cloud-point and pour-point apparatus', 'Bomb calorimeter', 'Separating and throttling calorimeter', '4-stroke diesel engine with rope-brake dynamometer and electrical load box'],
    industry: 'Steam and thermal power plants, gas-turbine power plants and the automobile industry.',
  },
];

export interface BranchInfo {
  id: Branch;
  name: string;
  url: string;
}

export const BRANCHES: BranchInfo[] = ([
  ['aerospace', 'Aerospace', 'Aerospace_engineering'], ['agricultural', 'Agricultural', 'Agricultural_engineering'],
  ['architectural', 'Architectural', 'Architectural_engineering'], ['biomedical', 'Biomedical', 'Biomedical_engineering'],
  ['chemical', 'Chemical', 'Chemical_engineering'], ['civil', 'Civil', 'Civil_engineering'],
  ['computer', 'Computer', 'Computer_engineering'], ['data', 'Data', 'Data_engineering'],
  ['design', 'Design', 'Design_engineer'], ['electrical', 'Electrical', 'Electrical_engineering'],
  ['electronics', 'Electronics', 'Electronics_engineering'], ['energy', 'Energy', 'Energy_engineering'],
  ['environmental', 'Environmental', 'Environmental_engineering'], ['industrial', 'Industrial', 'Industrial_engineering'],
  ['manufacturing', 'Manufacturing', 'Manufacturing_engineering'], ['marine', 'Marine', 'Marine_engineering'],
  ['materials', 'Materials', 'Materials_engineering'], ['mechanical', 'Mechanical', 'Mechanical_engineering'],
  ['mechatronics', 'Mechatronics', 'Mechatronics_engineering'], ['mining', 'Mining', 'Mining_engineering'],
  ['nuclear', 'Nuclear', 'Nuclear_engineering'], ['petroleum', 'Petroleum', 'Petroleum_engineering'],
  ['process', 'Process', 'Process_engineering'], ['robotics', 'Robotics', 'Robotics_engineering'],
  ['software', 'Software', 'Software_engineering'], ['structural', 'Structural', 'Structural_engineering'],
  ['systems', 'Systems', 'Systems_engineering'],
] as [Branch, string, string][]).map(([id, name, page]) => ({ id, name, url: `https://en.wikipedia.org/wiki/${page}` }));
