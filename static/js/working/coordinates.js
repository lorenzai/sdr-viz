$(function() {

    var learn = true;
    var noise = 0.00;

    var spClient;
    var tmClient;
    var computeClient;
    var modelId;

    // SP params we are not allowing user to change
    var encoderScale = 1200; // cartesian units
    var encoderTimestep = 0.5; // seconds
    var inputW = 11
    var inputDimensions = [500];
    var columnDimensions = [1024];
    var cellsPerColumn = 4;
    var spParams = new HTM.utils.sp.Params(
        'sp-params', inputDimensions, columnDimensions
    );
    var proximalConnectionThreshold = spParams.getParams()['synPermConnected'];
    // TM connection threshold
    var distalConnectionThreshold = 0.50;

    var counter = 0;
    var cameraPositions = [];
    var waitInterval = 1000;
    var moveModifier = 5;

    var $loading = $('#loading');
    // Indicates we are still waiting for a response from the server SP.
    var waitingForServer = false;

    // Turns on/off column and cell selection modes.
    var columnSelection = false;
    // segments
    var showProximal = false;
    var showSegments = false;
    var showPresynaptic = false;
    // cells
    var showActive = true;
    var showCorrect = true;
    var showWrong = true;
    var showPredicted = true;
    var showPredictive = false;

    // Counts of segments for selected cells.
    var selectedCellActiveSegmentCount = 0;
    var selectedCellMatchingSegmentCount = 0;

    var cellStates = HtmCellStates;

    var defaultSpCellSpacing = {
        x: 2.5, y: 3.1, z: 1.1
    };
    // var defaultCellsPerRow = Math.floor(Math.sqrt(columnDimensions[0]));
    var defaultCellsPerRow = 30;

    // One-step in the past.
    var lastPredictedCells = [];
    var lastActiveCells = [];

    // UI stuff
    var $activeSegmentDisplay = $('#active-segments');
    var $matchingSegmentDisplay = $('#matching-segments');
    var $confidenceDisplay = $('#confidence');
    var $x = $('#x');
    var $y = $('#y');
    var $z = $('#z');

    ////////////////////////////////////////////////////////////////////////////
    // These globals contain the HTM state that gets displayed on the cell
    // visualization. They get updated with every HTM cycle, and they are used
    // by the rendered to paint the visualization.
    ////////////////////////////////////////////////////////////////////////////

    // The HtmCells objects that contains cell state. This is the inteface for
    // making changes to cell-viz.
    var inputCells, spColumns;
    // The Viz object.
    var cellviz;
    // The raw HTM state being sent from the server.
    var htmState;

    ////////////////////////////////////////////////////////////////////////////
    // Utility functions
    ////////////////////////////////////////////////////////////////////////////

    function getRandomInt(min, max) {
        min = Math.ceil(min);
        max = Math.floor(max);
        return Math.floor(Math.random() * (max - min)) + min;
    }

    function countIntsIntoArray(size) {
        var out = [];
        _.times(size, function(count) {
            out.push(count);
        });
        return out;
    }

    /* From http://stackoverflow.com/questions/7128675/from-green-to-red-color-depend-on-percentage */
    function getGreenToRed(percent){
        var r, g;
        percent = 100 - percent;
        r = percent < 50 ? 255 : Math.floor(255-(percent*2-100)*255/100);
        g = percent > 50 ? 255 : Math.floor((percent*2)*255/100);
        return new THREE.Color(r, g, 0);
    }

    function averageRGB(c1, c2) {
        return c1.clone().lerp(c2, 0.5);
    }

    function translate(x, min, max) {
        var range = max - min;
        return (x - min) / range;
    }

    function xyzToOneDimIndex(x, y, z, xMax, yMax, zMax) {
        var result = (z * xMax * yMax) + (y * xMax) + x;
        return result;
    }

    function cellXyToColumnIndex(x, y, xMax) {
        return y * xMax + x;
    }

    ////////////////////////////////////////////////////////////////////////////
    // UI functions
    ////////////////////////////////////////////////////////////////////////////

    function loading(isLoading, isModal) {
        if (isModal == undefined) {
            isModal = true;
        }
        if (isLoading) {
            waitingForServer = true;
            if (! isModal) {
                $loading.addClass('little');
            }
            $loading.show();
        } else {
            waitingForServer = false;
            $loading.hide();
            $loading.removeClass('little');
        }
    }

    function buildLegend() {
        var $legend = $('#legend ul');
        _.each(cellStates, function(state) {
            var $item = $('<li class="' + state.state + '">');
            var $span = $('<span>');
            var $name = $('<p>' + state.description + '</p>');
            $span.css('background-color', '#' + state.color.getHexString());
            $span.appendTo($item);
            $name.appendTo($item);
            $item.appendTo($legend);
        });
    }

    function updateLegend() {
        $('#legend ul li.active').toggle(showActive);
        $('#legend ul li.predictive').toggle(showPredicted);
        $('#legend ul li.previouslyPredictive').toggle(showPredictive);
        $('#legend ul li.correctlyPredicted').toggle(showCorrect);
        $('#legend ul li.predictiveActive').toggle(showPredicted);
        $('#legend ul li.wronglyPredicted').toggle(showWrong);
    }

    function addClickHandling() {

        function spClicked(cellData) {
            cellData.cellIndex = xyzToOneDimIndex(
                cellData.z, cellData.x, cellData.y,
                spColumns.getZ(), spColumns.getX(), spColumns.getY()
            );
            if (columnSelection) {
                spColumns.selectedColumn = cellXyToColumnIndex(
                    cellData.x, cellData.y, spColumns.getX()
                );
            } else {
                spColumns.selectedColumn = undefined;
            }
            spColumns.selectedCell = cellData.cellIndex;
            console.log( "clicked:  col %s cell %s",
                spColumns.selectedColumn, spColumns.selectedCell);
        }

        function cellClicked(cellData) {
            spColumns.selectedCell = undefined;
            spColumns.selectedColumn = undefined;
            inputCells.selectedCell = undefined;
            // Not handling input space selections.
            if (cellData.type == 'inputCells') return;
            else spClicked(cellData);
            updateCellRepresentations();
        }

        function onDocumentMouseDown( event ) {
            event.preventDefault();

            // update the mouse variable
            var x = ( event.clientX / cellviz.renderer.domElement.clientWidth ) * 2 - 1;
            var y = - ( event.clientY / cellviz.renderer.domElement.clientHeight ) * 2 + 1;

            // find intersections
            // create a Ray with origin at the mouse position
            //   and direction into the scene (camera direction)
            var vector = new THREE.Vector3( x, y, 1 );
            vector.unproject(cellviz.camera);
            var ray = new THREE.Raycaster( cellviz.camera.position, vector.sub( cellviz.camera.position ).normalize() );
            // create an array containing all objects in the scene with which the ray intersects
            var intersects = ray.intersectObjects(cellviz.getTargets());

            // if there is one (or more) intersections
            if ( intersects.length > 0 ) {
                cellClicked(intersects[0].object._cellData);
            }
        }
        $('canvas').click(onDocumentMouseDown);
    }

    ////////////////////////////////////////////////////////////////////////////
    // CellViz functions
    ////////////////////////////////////////////////////////////////////////////

    function setupCellViz() {
        inputCells = new InputCells(inputDimensions, true);
        spColumns = new HtmMiniColumns(columnDimensions[0], cellsPerColumn, {
            cellsPerRow: defaultCellsPerRow
        });
        cellviz = new CompleteHtmVisualization(inputCells, spColumns, {
            camera: {
                x: 300,
                y: 2000,
                z: 8000
            },
            lookCenter: true,
            spacing: defaultSpCellSpacing,
            layerSpacing: 60
        });
        clearAllCells();
        cellviz.render();
    }

    function clearAllSelections() {
        spColumns.selectedCell = undefined;
        spColumns.selectedColumn = undefined;
        $('#note-columns ul li').removeClass('on');
        spColumns.updateAll({highlight: false});
        selectedNote = undefined;
    }

    function clearAllCells() {
        spColumns.updateAll(cellStates.inactive);
        inputCells.updateAll(cellStates.inactive);
    }

    // Here be the logic that updates the cell-viz structures, thus enabling it
    // to animate along with the changing HTM state and responding to user
    // interaction. It be a long function.

    function cellStateIsActive(state) {
        return state == cellStates.active.state
            || state == cellStates.correctlyPredicted.state
            || state == cellStates.predictiveActive.state;
    }

    function cellStateIsInActive(state) {
        return state == cellStates.inactive.state
            || state == cellStates.withinActiveColumn.state
            || state == cellStates.wronglyPredicted.state;
    }

    function cellStateIsPredictive(state) {
        return state == cellStates.predictive.state
            || state == cellStates.predictiveActive.state;
    }

    function selectHtmCell(cellValue, currentSegments) {
        selectedCellActiveSegmentCount = 0;
        selectedCellMatchingSegmentCount = 0;
        console.log(cellValue);

        function populateSegments(segs, cellIndex) {
            _.each(segs, function(segment) {
                if (segment.cell == cellIndex) {
                    var segOut = {
                        source: cellIndex,
                        connected: segment.connected,
                        predictiveTarget: true,
                        synapses: []
                    };
                    _.each(segment.synapses, function(synapse) {
                        segOut.synapses.push({
                            target: synapse.presynapticCell,
                            permanence: synapse.permanence,
                        });
                    });
                    cellviz.distalSegments.push(segOut);
                    if (segment.connected) {
                        selectedCellActiveSegmentCount++;
                    } else {
                        selectedCellMatchingSegmentCount++;
                    }
                }
            });
        }

        if (showSegments) {
            console.log('Displaying current segments for %s', cellValue.cellIndex);
            populateSegments(currentSegments, cellValue.cellIndex);
        }

        if (showPresynaptic) {
            console.log('Displaying current segments where %s is presynaptic', cellValue.cellIndex);
            var presynapticSegments = _.filter(currentSegments, function(segment) {
                var match = _.find(segment.synapses, function(synapse) {
                    return synapse.presynapticCell == cellValue.cellIndex;
                });
                return !!match;
            });
            // console.log('found %s presynaptic segments', presynapticSegments.length);
            _.each(presynapticSegments, function(segment) {
                var segOut = {
                    source: segment.cell,
                    connected: segment.connected,
                    predictiveTarget: true,
                    synapses: []
                };
                _.each(segment.synapses, function(synapse) {
                    if (synapse.presynapticCell == cellValue.cellIndex) {
                        segOut.synapses.push({
                            target: synapse.presynapticCell,
                            permanence: synapse.permanence,
                        });
                    }
                });
                cellviz.distalSegments.push(segOut);
                if (segment.connected) {
                    selectedCellActiveSegmentCount++;
                } else {
                    selectedCellMatchingSegmentCount++;
                }
            });
        }

    }

    function selectColumn(columnIndex, allSegments, connectedSynapses) {
        var cells = spColumns.getCellsInColumn(columnIndex);
        var firstCell = cells[0];
        _.each(cells, function(cellValue) {
            selectHtmCell(cellValue, allSegments);
        });
        if (showProximal) {
            _.each(connectedSynapses, function(proximalSynapse) {
                cellviz.proximalSegments.push({
                    source: firstCell.cellIndex,
                    target: proximalSynapse
                });
            });
        }
    }

    function mergeSegments(left, right) {
        return _.map(left, function(lval) {
            var lcompare = JSON.stringify(lval);
            var connected = false;
            var rval = _.find(right, function(rval) {
                return JSON.stringify(rval) == lcompare;
            });
            if (rval) {
                connected = true;
            }
            return _.extend({}, lval, {connected: connected});
        });
    }

    function updateCellRepresentations() {
        var inputEncoding = htmState.inputEncoding;
        var activeColumns = htmState.activeColumns;
        var activeDutyCycles = htmState.activeDutyCycles;
        var overlapDutyCycles = htmState.overlapDutyCycles;
        var potentialPools  = htmState.potentialPools;
        var connectedSynapses = htmState.connectedSynapses;
        var activeSegments = htmState.activeSegments;
        var matchingSegments = htmState.matchingSegments;
        var allSegments = htmState.allSegments;
        var predictiveCellIndices = htmState.predictiveCells;
        var receptiveField;
        var inhibitionMasks  = htmState.inhibitionMasks;
        var neighbors;
        var dutyCycle, minDutyCycle, maxDutyCycle, percent;
        var columnIndex, cellIndex;
        var globalCellIndex;
        var cx, cy, cz;
        var thisCellIndex, thisColumnIndex;
        var xMax, yMax, zMax;
        var color, state;
        var cellValue;

        var activeColumnIndices = SDR.tools.getActiveBits(activeColumns);
        var activeCellIndices = htmState.activeCells;

        _.each(inputEncoding, function(value, index) {
            var state = cellStates.inactive;
            if (value == 1) {
                state = cellStates.input;
            }
            state = _.extend(state, {cellIndex: index});
            inputCells.update(index, state);
        });

        _.times(spColumns.getNumberOfCells(), function(globalCellIndex) {
            var columnIndex = Math.floor(globalCellIndex / cellsPerColumn);

            if (activeColumnIndices.indexOf(columnIndex) > -1) {
                // Column is active.
                state = cellStates.withinActiveColumn;
            } else {
                state = cellStates.inactive;
            }
            if (showPredictive && lastPredictedCells.indexOf(globalCellIndex) > -1) {
                state = cellStates.previouslyPredictive;
            }

            if (activeCellIndices.indexOf(globalCellIndex) > -1) {
                // Cell is active.
                if (showActive) {
                    state = cellStates.active;
                }
                if (showPredicted && predictiveCellIndices.indexOf(globalCellIndex) > -1) {
                    state = cellStates.predictiveActive;
                }
                if (showCorrect && lastPredictedCells.indexOf(globalCellIndex) > -1) {
                    state = cellStates.correctlyPredicted;
                }
            } else if (showPredicted && predictiveCellIndices.indexOf(globalCellIndex) > -1) {
                // Cell is predictive.
                state = cellStates.predictive;
            } else {
                // Cell is not active.
                if (showWrong && lastPredictedCells.indexOf(globalCellIndex) > -1) {
                    // Cell was predicted last step, but not active.
                    state = cellStates.wronglyPredicted;
                }
            }

            state = _.extend(state, {
                cellIndex: globalCellIndex,
                columnIndex: columnIndex
            });
            spColumns.update(globalCellIndex, state);

        });

        // selectedCellActiveSegmentCount = activeSegments.length;
        // selectedCellMatchingSegmentCount = matchingSegments.length;
        cellviz.distalSegments = [];
        cellviz.proximalSegments = [];
        if (columnSelection && spColumns.selectedColumn) {
            selectColumn(
                spColumns.selectedColumn,
                allSegments,
                connectedSynapses[spColumns.selectedColumn]
            );
        } else if (spColumns.selectedCell) {
            cellValue = spColumns.cells[spColumns.selectedCell];
            selectHtmCell(cellValue, allSegments);
        }

        cellviz.redraw();
        updateLegend();

    }

    function drawCameraPath() {
        var camPathGrid;
        if (cameraPositions.length <= 1) {
            return;
        }

        if (! cellviz.camPathGrid) {
            camPathGrid = new THREE.Group();
            cellviz.scene.add(camPathGrid);
        } else {
            camPathGrid = cellviz.camPathGrid;
        }

        var material = new THREE.LineBasicMaterial({
            color: 0x0000ff
        });
        var meshOpacity = 1.0;
        var position1 = cameraPositions[cameraPositions.length - 2];
        var position2 = cameraPositions[cameraPositions.length - 1];
        var color = new THREE.Color('black');
        var lineGeo = new THREE.Geometry();
        lineGeo.vertices.push(position1, position2);
        var material = new THREE.LineBasicMaterial({
        	color: color, linewidth: 3.0
        });
        var line = new THREE.Line(lineGeo, material);
        // put a dot in the last point
        var dotGeometry = new THREE.Geometry();
        dotGeometry.vertices.push(position2);
        var dotMaterial = new THREE.PointsMaterial({
            size: 10, sizeAttenuation: false,
            color: color
        });
        var dot = new THREE.Points(dotGeometry, dotMaterial);
        camPathGrid.add(dot);
        camPathGrid.add(line);
    }

    function setupDatGui() {
        var params = {
            // input
            'input-x': 1.1,
            'input-y': 1.1,
            'input-z': 1.1,
            // sp
            'sp-x': defaultSpCellSpacing.x,
            'sp-y': defaultSpCellSpacing.y,
            'sp-z': defaultSpCellSpacing.z,
            'cells per row': defaultCellsPerRow,
            // display options
            'column selection': columnSelection,
            'predictive': showPredictive,
            'active': showActive,
            'predicted': showPredicted,
            'show correct': showCorrect,
            'show wrong': showWrong,
            // segments
            'proximal': showProximal,
            'segments': showSegments,
            'presynaptic': showPresynaptic
        };
        var minSpacing = 1.1;
        var maxSpacing = 10.0;
        var gui = new dat.GUI();

        var inputSpacing = gui.addFolder('Input Spacing');
        inputSpacing.add(params, 'input-x', minSpacing, maxSpacing)
        .onChange(function(spacing) {
            cellviz.inputSpacing.x = spacing;
            updateCellRepresentations();
        });
        inputSpacing.add(params, 'input-y', minSpacing, maxSpacing)
        .onChange(function(spacing) {
            cellviz.inputSpacing.y = spacing;
            updateCellRepresentations();
        });
        inputSpacing.add(params, 'input-z', minSpacing, maxSpacing)
        .onChange(function(spacing) {
            cellviz.inputSpacing.z = spacing;
            updateCellRepresentations();
        });

        var spSpacing = gui.addFolder('SP Spacing');
        spSpacing.add(params, 'sp-x', minSpacing, maxSpacing)
        .onChange(function(spacing) {
            cellviz.spacing.x = spacing;
            updateCellRepresentations();
        });
        spSpacing.add(params, 'sp-y', minSpacing, maxSpacing)
        .onChange(function(spacing) {
            cellviz.spacing.y = spacing;
            updateCellRepresentations();
        });
        spSpacing.add(params, 'sp-z', minSpacing, maxSpacing)
        .onChange(function(spacing) {
            cellviz.spacing.z = spacing;
            updateCellRepresentations();
        });
        spSpacing.add(params, 'cells per row').onChange(function(cells) {
            cellviz.redim(cells);
            updateCellRepresentations();
        });
        spSpacing.open();

        var selectionModes = gui.addFolder('Display Options');
        selectionModes.add(params, 'column selection').onChange(function(isOn) {
            columnSelection = isOn;
            updateCellRepresentations();
        });
        selectionModes.add(params, 'active').onChange(function(isOn) {
            showActive = isOn;
            updateCellRepresentations();
        });
        selectionModes.add(params, 'predicted').onChange(function(isOn) {
            showPredicted = isOn;
            updateCellRepresentations();
        });
        selectionModes.add(params, 'predictive').onChange(function(isOn) {
            showPredictive = isOn;
            updateCellRepresentations();
        });
        selectionModes.add(params, 'show correct').onChange(function(isOn) {
            showCorrect = isOn;
            updateCellRepresentations();
        });
        selectionModes.add(params, 'show wrong').onChange(function(isOn) {
            showWrong = isOn;
            updateCellRepresentations();
        });
        selectionModes.open();

        var segmentModes = gui.addFolder('Segments');
        segmentModes.add(params, 'proximal').onChange(function(isOn) {
            showProximal = isOn;
            updateCellRepresentations();
        });
        segmentModes.add(params, 'segments').onChange(function(isOn) {
            showSegments = isOn;
            updateCellRepresentations();
        });
        segmentModes.add(params, 'presynaptic').onChange(function(isOn) {
            showPresynaptic = isOn;
            updateCellRepresentations();
        });
        segmentModes.open();
    }

    ////////////////////////////////////////
    // HTM-related functions
    ////////////////////////////////////////

    function getTmParams() {
        // TODO: Provide a UI to change TM Params.
        return {
            columnDimensions: columnDimensions,
            cellsPerColumn: cellsPerColumn,
            activationThreshold: 10,
            initialPermanence: 0.21,
            connectedPermanence: distalConnectionThreshold,
            minThreshold: 10,
            maxNewSynapseCount: 20,
            permanenceIncrement: 0.10,
            permanenceDecrement: 0.05,
            predictedSegmentDecrement: 0.0,
            maxSegmentsPerCell: 128,
            maxSynapsesPerSegment: 32
        };
    }

    function initModel(callback) {
        spClient = new HTM.SpatialPoolerClient();
        tmClient = new HTM.TemporalMemoryClient();
        loading(true);
        spParams.setParam('boostStrength', 2);
        spParams.setParam('potentialRadius', inputDimensions[0]);
        spParams.setParam('globalInhibition', true);
        spClient.initialize(spParams.getParams(), function(err, spResp) {
            console.log('SP initialized.');
            modelId = spResp.id;
            // Create encoder
            $.ajax({
                type: 'POST',
                url: '/_proxy/_encodeCoordinate/',
                data: JSON.stringify({
                    id: modelId,
                    scale: encoderScale,
                    timestep: encoderTimestep,
                    w: inputW,
                    n: inputDimensions[0]
                }),
                success: function(response) {
                    var tmParams = getTmParams();
                    tmClient.initialize(tmParams, {id: spClient._id}, function(tmResp) {
                        console.log('TM initialized.');
                        loading(false);
                        if (callback) callback(null, spResp, tmResp);
                    });
                },
                dataType: 'JSON'
            });
        });
    }

    function getSpeed(point1, point2, timestep) {
        var dist = point1.distanceTo(point2);
        return dist / timestep; // units per second
    }

    function encodePosition(position, speed, timestamp, callback) {
        $.ajax({
            type: 'PUT',
            url: '/_proxy/_encodeCoordinate/',
            data: JSON.stringify({
                position: position,
                speed: speed,
                timestamp: timestamp,
                id: modelId
            }),
            success: callback,
            dataType: 'JSON'
        });
    }

    function compute(encoding, reset, mainCallback) {
        var requestedStates = [
            HTM.SpSnapshots.ACT_COL
        ];
        spClient.compute(encoding, true, requestedStates, function(err, spResp) {
            if (err) return mainCallback(err);
            var state = spResp.state;
            var tmOpts = {
                reset: reset
            };

            tmClient.compute(state.activeColumns, tmOpts, function(err, tmResp) {
                if (err) return mainCallback(err);
                state = _.extend(state, tmResp);
                mainCallback(null, state);
            });
        });
    }

    function runOnePosition(position, timestamp, callback) {
        // Encode data point into SDR.
        var lastPosition = undefined;
        var speed = 0;
        if (cameraPositions.length > 1) {
            lastPosition = cameraPositions[cameraPositions.length - 2];
            speed = getSpeed(lastPosition, position, encoderTimestep);
        }
        encodePosition(position, speed, timestamp, function(resp) {
            var reset = false;
            var encoding = resp.encoding;
            compute(encoding, reset, function(error, state) {
                htmState = state;
                // Stash current predictive cells to use for next render.
                lastPredictedCells = htmState.predictiveCells || [];
                lastActiveCells = htmState.activeCells || [];
                counter++;
                if (reset) {
                    console.log('TM Reset after this row of data.');
                }
                // Merge segments into on structure.
                htmState.allSegments = mergeSegments(
                    htmState.matchingSegments, htmState.activeSegments
                );
                // Add the encoding as well.
                htmState.inputEncoding = encoding;
                updateCellRepresentations();
                $x.html(Math.round(position.x));
                $y.html(Math.round(position.y));
                $z.html(Math.round(position.z));
                spColumns.updateAll({highlight: false});
                // Stash info about columns related to this prediction.
                lastActiveColumns = htmState.activeColumns;

                drawCameraPath();
                callback();
            });

        });
    }

    ////////////////////////////////////////
    // Global Program Start
    ////////////////////////////////////////

    function start() {

        $('h1').remove();

        // Deselect all on ESC.
        window.addEventListener('keyup', function(event) {
            if (event.keyCode == 27) {
                clearAllSelections();
                updateCellRepresentations();
            }
        }, false );

        initModel(function(err, spResp, tmResp) {
            if (err) throw err;
            // Initial HTM state is not complete, but we'll show it anyway.
            htmState = _.extend(spResp, tmResp);
            setupCellViz();
            addClickHandling();
            setupDatGui();
            buildLegend();
            loading(false);

            cellviz.controls.movementSpeed
                = cellviz.controls.movementSpeed * moveModifier;

            function step() {
                var position = cellviz.camera.position;
                if (waitingForServer) {
                    console.warn('still computing, skipping this point');
                } else {
                    cameraPositions.push(position.clone());
                    waitingForServer = true;
                    runOnePosition(position, new Date().getTime(), function() {
                        waitingForServer = false;
                    });
                }
            }

            setInterval(step, encoderTimestep * 1000);

        });
    }

    start();

});
