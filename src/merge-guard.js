// La regla que decide cuándo un parecido de nombre NO alcanza para fusionar.
//
// `findOrCreatePerson` fusiona un reporte nuevo con una persona existente
// cuando el nombre normalizado puntúa >= 0.85, y nada más entra en la decisión
// (#150). Un caso de producción juntó seis fichas de dos departamentos a 200 km
// con edades de 20 y 36. Subir el umbral no arregla nada: 0.855 y 0.85 son
// cinco milésimas, pero «Jhon» contra «John» da 0.967 y ahí sí queremos
// fusionar. El número no es el problema — la señal es insuficiente.
//
// Acá entran las dos señales que faltaban. La asimetría de costos manda:
//
//   · Vetar de más deja a una persona en dos registros. Sale en el aviso de
//     posible duplicado que ya existe y una persona los une.
//   · Vetar de menos junta a dos personas distintas, y entonces marcar a una
//     como localizada saca de la lista de buscados a la otra. Es el daño más
//     grave que puede hacer esta app.
//
// Por eso el veto es estricto: basta que UNA sola de las declaraciones del
// registro contradiga la que llega. La regla más suave —«que no coincida con
// ninguna»— se debilita justo en los registros ya contaminados por una fusión
// mala, que son los que hay que dejar de alimentar.

// Cinco años. La edad que declara una familia casi siempre es una estimación, y
// además se mueve sola: una ficha de hace dos años dice 33 y la de hoy dice 35.
// El margen tiene que absorber las dos cosas sin tragarse el caso real del
// issue, donde 24 y 33 son nueve años de diferencia.
const AGE_MARGIN_YEARS = 5;

// Devuelve por qué NO se puede fusionar, o null si nada lo impide.
//
// `incoming` trae las señales del reporte que llega, ya canonicalizadas.
// `updates` son las filas que el registro candidato ya tiene.
//
// Una señal ausente —de cualquiera de los dos lados— nunca veta. Un dato que no
// llegó no es evidencia de que dos personas sean distintas, y la mayoría de los
// updates no lo traen: los anteriores a estas columnas, los del bot y los del
// agregador. Sin esa regla, el veto se comería casi toda fusión legítima.
function mergeBlockReason({ department, age }, updates = []) {
  if (department) {
    for (const u of updates) {
      if (u.department && u.department !== department) return 'department';
    }
  }
  if (age !== null && age !== undefined) {
    for (const u of updates) {
      if (u.age === null || u.age === undefined) continue;
      if (Math.abs(u.age - age) > AGE_MARGIN_YEARS) return 'age';
    }
  }
  return null;
}

module.exports = { AGE_MARGIN_YEARS, mergeBlockReason };
